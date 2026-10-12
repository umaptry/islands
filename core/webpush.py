"""Web Push without a library: VAPID (RFC 8292) and aes128gcm (RFC 8291).

A browser that agreed to notifications hands us a subscription: an endpoint
URL at its push service (Google, Mozilla, Apple, Microsoft) plus two keys of
its own. To reach it we

  1. sign a short JWT with our VAPID key, so the push service knows the
     message comes from the server the browser subscribed to, and
  2. encrypt the payload to the browser's keys, so the push service carries
     it without being able to read it.

`cryptography` already does the curve and AES work (core/auth.py needs it for
Supabase's ES256 tokens), so this file is only the framing the two RFCs
describe. pywebpush would pull in py-vapid, http-ece and requests for the
same few dozen lines.

Endpoints are checked against the known push services both when a browser
subscribes and again before every send: an endpoint is an address the server
will POST to, and it must never be one a caller picked.
"""

import base64
import json
import os
import struct
import time
from urllib.parse import urlsplit

import httpx
from cryptography.hazmat.primitives import hashes, hmac, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# Chrome, Edge-on-Android, Samsung, Opera -> FCM; Firefox -> Mozilla;
# Safari and iPhone home-screen apps -> Apple; Edge on Windows -> WNS.
PUSH_HOSTS = ("fcm.googleapis.com", "updates.push.services.mozilla.com")
PUSH_HOST_SUFFIXES = (".push.apple.com", ".notify.windows.com")

RECORD_SIZE = 4096
# Push services accept 4096 bytes of body; the header and the AES tag take
# 86 + 16 of them, and the padding delimiter one more.
MAX_PAYLOAD = RECORD_SIZE - 86 - 16 - 1
JWT_HOURS = 12  # RFC 8292 caps exp at 24 hours.


def b64u(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def unb64u(text):
    text = str(text).strip()
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _public_bytes(key):
    return key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def new_keys():
    """A fresh VAPID pair as (public, private), both base64url.

    public is the 65-byte uncompressed point browsers take as
    applicationServerKey; private is the raw 32-byte scalar.
    """
    key = ec.generate_private_key(ec.SECP256R1())
    scalar = key.private_numbers().private_value.to_bytes(32, "big")
    return b64u(_public_bytes(key)), b64u(scalar)


def private_key(private_b64u):
    return ec.derive_private_key(int.from_bytes(unb64u(private_b64u), "big"), ec.SECP256R1())


def keys_match(public_b64u, private_b64u):
    try:
        return b64u(_public_bytes(private_key(private_b64u))) == public_b64u
    except (ValueError, TypeError):
        return False


def allowed_endpoint(url):
    """True only for an https URL on a known push service, default port."""
    try:
        parts = urlsplit(str(url))
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError:
        return False
    if parts.scheme != "https" or parts.username or parts.password:
        return False
    if port not in (None, 443):
        return False
    return host in PUSH_HOSTS or any(host.endswith(suffix) and len(host) > len(suffix)
                                     for suffix in PUSH_HOST_SUFFIXES)


def vapid_header(endpoint, public_b64u, private_b64u, subject, now=None):
    """The Authorization header for one push service (RFC 8292 section 3)."""
    parts = urlsplit(endpoint)
    claims = {
        "aud": f"{parts.scheme}://{parts.netloc}",
        "exp": int(now if now is not None else time.time()) + JWT_HOURS * 3600,
        "sub": subject,
    }
    header = {"typ": "JWT", "alg": "ES256"}
    signing_input = ".".join(
        b64u(json.dumps(part, separators=(",", ":")).encode("utf-8")) for part in (header, claims))
    der = private_key(private_b64u).sign(signing_input.encode("ascii"), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    token = signing_input + "." + b64u(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
    return f"vapid t={token}, k={public_b64u}"


def _hmac(key, data):
    mac = hmac.HMAC(key, hashes.SHA256())
    mac.update(data)
    return mac.finalize()


def encrypt(payload, p256dh_b64u, auth_b64u, *, salt=None, server_key=None):
    """Encrypt `payload` (bytes) for one browser, as an aes128gcm body.

    salt and server_key are only for tests; a real send makes fresh ones.
    """
    if len(payload) > MAX_PAYLOAD:
        raise ValueError(f"push payload is {len(payload)} bytes; at most {MAX_PAYLOAD}")
    ua_public = unb64u(p256dh_b64u)
    auth_secret = unb64u(auth_b64u)
    if len(ua_public) != 65 or ua_public[0] != 4 or len(auth_secret) != 16:
        raise ValueError("subscription keys have the wrong shape")
    receiver = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    sender = server_key or ec.generate_private_key(ec.SECP256R1())
    as_public = _public_bytes(sender)
    salt = salt or os.urandom(16)

    shared = sender.exchange(ec.ECDH(), receiver)
    prk_key = _hmac(auth_secret, shared)
    ikm = _hmac(prk_key, b"WebPush: info\x00" + ua_public + as_public + b"\x01")
    prk = _hmac(salt, ikm)
    cek = _hmac(prk, b"Content-Encoding: aes128gcm\x00\x01")[:16]
    nonce = _hmac(prk, b"Content-Encoding: nonce\x00\x01")[:12]

    record = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    header = salt + struct.pack("!IB", RECORD_SIZE, len(as_public)) + as_public
    return header + record


def send(subscription, message, *, public_b64u, private_b64u, subject,
         ttl=86400, urgency="normal", topic=None, client=None, timeout=10.0):
    """POST one message. Returns "sent", "gone" (forget this subscription) or "failed".

    subscription: {"endpoint", "p256dh", "auth"}; message: a JSON-able dict.
    topic (at most 32 base64url characters) lets the push service replace an
    undelivered message with a newer one about the same thing.
    """
    endpoint = subscription.get("endpoint", "")
    if not allowed_endpoint(endpoint):
        return "gone"
    try:
        body = encrypt(json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
                       subscription.get("p256dh", ""), subscription.get("auth", ""))
    except ValueError:
        return "gone"
    headers = {
        "Authorization": vapid_header(endpoint, public_b64u, private_b64u, subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": str(int(ttl)),
        "Urgency": urgency,
    }
    if topic:
        headers["Topic"] = topic[:32]
    try:
        if client is not None:
            response = client.post(endpoint, content=body, headers=headers, timeout=timeout)
        else:
            response = httpx.post(endpoint, content=body, headers=headers, timeout=timeout)
    except httpx.HTTPError:
        return "failed"
    if response.status_code in (404, 410):
        return "gone"
    return "sent" if 200 <= response.status_code < 300 else "failed"


def topic_for(text):
    """A Topic header value for `text`: base64url, 32 characters at most."""
    digest = hashes.Hash(hashes.SHA256())
    digest.update(str(text).encode("utf-8"))
    return b64u(digest.finalize())[:32]
