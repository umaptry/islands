"""Who is making this request.

The browser signs in against Supabase Auth (GoTrue) and gets a JWT. Two of the
five API routes write on that person's behalf, so those two have to be sure the
token is real and has not been edited. Everything else the app does - reading
posts, leaving a comment, marking a notification read - never comes through
here at all: the browser talks to PostgREST directly and Postgres checks the
same token itself, through RLS.

Two signing schemes, because Supabase is in the middle of moving between them:

  HS256 with the project's JWT secret   - every project has this today
  ES256/RS256 against the project JWKS  - what new projects are moving to

Both are supported and neither is guessed at: the token's own `alg` header
picks the path, and an `alg` we do not recognise is rejected rather than
skipped. `alg: none` and the HS256-signed-with-the-public-key trick are both
refused by construction, since the HS256 branch only ever uses the configured
secret and the asymmetric branch only ever uses a key fetched from the JWKS.

Verification is local. There is a GoTrue endpoint (`/auth/v1/user`) that would
answer "is this token good", but calling it would put a network round trip in
front of every post - and put Supabase's availability in front of our own.
"""

import base64
import hashlib
import hmac
import json
import os
import threading
import time

import httpx

# 60 seconds of slack on expiry. Phones with a slightly wrong clock are common
# enough that being strict here reads to the user as "it randomly logged me out".
CLOCK_SKEW = 60
JWKS_TTL = 600  # seconds; a rotated key becomes usable within ten minutes
JWKS_TIMEOUT = 5.0

_jwks_cache = {"fetched": 0.0, "keys": {}}
_jwks_lock = threading.Lock()


class AuthError(Exception):
    """The token is missing, malformed, expired, or not ours."""


def _b64(segment):
    return base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))


def _split(token):
    parts = token.split(".")
    if len(parts) != 3:
        raise AuthError("token")
    try:
        header = json.loads(_b64(parts[0]))
        payload = json.loads(_b64(parts[1]))
        signature = _b64(parts[2])
    except (ValueError, json.JSONDecodeError):
        raise AuthError("token")
    signed = f"{parts[0]}.{parts[1]}".encode("ascii")
    return header, payload, signature, signed


def _verify_hs256(signed, signature, secret):
    expected = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).digest()
    # compare_digest, not ==: a plain comparison leaks where the first mismatch
    # is, and a signature is exactly the kind of thing that gets guessed a byte
    # at a time.
    if not hmac.compare_digest(expected, signature):
        raise AuthError("signature")


def _jwks_url():
    url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    return f"{url}/auth/v1/.well-known/jwks.json" if url else ""


def _jwks_keys(force=False):
    now = time.time()
    with _jwks_lock:
        fresh = now - _jwks_cache["fetched"] < JWKS_TTL
        if fresh and not force and _jwks_cache["keys"]:
            return _jwks_cache["keys"]
    url = _jwks_url()
    if not url:
        return {}
    try:
        response = httpx.get(url, timeout=JWKS_TIMEOUT)
        response.raise_for_status()
        keys = {key["kid"]: key for key in response.json().get("keys", []) if key.get("kid")}
    except (httpx.HTTPError, ValueError, KeyError):
        # Serve the stale set rather than logging everybody out because the key
        # endpoint blipped. An expired token still fails on `exp` below.
        with _jwks_lock:
            return _jwks_cache["keys"]
    with _jwks_lock:
        _jwks_cache["fetched"] = now
        _jwks_cache["keys"] = keys
        return keys


def _verify_asymmetric(header, signed, signature):
    kid = header.get("kid")
    if not kid:
        raise AuthError("kid")
    keys = _jwks_keys()
    key = keys.get(kid)
    if key is None:
        # A key we have never seen usually means rotation, not an attack.
        key = _jwks_keys(force=True).get(kid)
    if key is None:
        raise AuthError("kid")

    try:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
    except ImportError:
        # Only reachable on a build that dropped the dependency. Refusing is the
        # only honest answer: the alternative is accepting an unverified token.
        raise AuthError("unsupported")

    algorithm = header.get("alg")
    try:
        if key.get("kty") == "EC" and algorithm == "ES256":
            from cryptography.hazmat.primitives.asymmetric.utils import (
                encode_dss_signature,
            )
            numbers = ec.EllipticCurvePublicNumbers(
                int.from_bytes(_b64(key["x"]), "big"),
                int.from_bytes(_b64(key["y"]), "big"),
                ec.SECP256R1(),
            )
            half = len(signature) // 2
            der = encode_dss_signature(
                int.from_bytes(signature[:half], "big"),
                int.from_bytes(signature[half:], "big"),
            )
            numbers.public_key().verify(der, signed, ec.ECDSA(hashes.SHA256()))
            return
        if key.get("kty") == "RSA" and algorithm == "RS256":
            numbers = rsa.RSAPublicNumbers(
                int.from_bytes(_b64(key["e"]), "big"),
                int.from_bytes(_b64(key["n"]), "big"),
            )
            numbers.public_key().verify(
                signature, signed, padding.PKCS1v15(), hashes.SHA256()
            )
            return
    except Exception:
        raise AuthError("signature")
    # A kty/alg pair we do not implement. Never fall through to "accept".
    raise AuthError("alg")


def verify(token):
    """The claims inside a valid token, or AuthError.

    Returns the whole payload rather than just the id: `email` is wanted once,
    to seed a new account's display name, and re-fetching it from GoTrue for
    that would be a request per sign-up.
    """
    if not token:
        raise AuthError("missing")
    header, payload, signature, signed = _split(token)

    algorithm = header.get("alg")
    if algorithm == "HS256":
        secret = os.environ.get("SUPABASE_JWT_SECRET", "").strip()
        if not secret:
            raise AuthError("unconfigured")
        _verify_hs256(signed, signature, secret)
    elif algorithm in ("ES256", "RS256"):
        _verify_asymmetric(header, signed, signature)
    else:
        raise AuthError("alg")

    now = time.time()
    expires = payload.get("exp")
    if not isinstance(expires, (int, float)) or now - CLOCK_SKEW > expires:
        raise AuthError("expired")
    issued = payload.get("iat")
    if isinstance(issued, (int, float)) and issued - CLOCK_SKEW > now:
        raise AuthError("future")
    # Supabase puts "authenticated" here for a signed-in user and "anon" for the
    # anonymous key. An anon key is a valid signature and must still not count
    # as a person.
    if payload.get("role") != "authenticated":
        raise AuthError("role")
    if not payload.get("sub"):
        raise AuthError("sub")
    return payload


def bearer(request):
    """The token out of an Authorization header, or ''."""
    header = request.headers.get("authorization", "")
    scheme, _, value = header.partition(" ")
    return value.strip() if scheme.lower() == "bearer" else ""


def configured():
    """True when this deployment can verify a token at all."""
    return bool(os.environ.get("SUPABASE_JWT_SECRET", "").strip() or _jwks_url())


# ---------------------------------------------------------------------------
# Local development without a Supabase project.
#
# create_store() already falls back to an in-memory store when SUPABASE_URL is
# unset, so the whole app runs offline. Auth has to follow it or the offline
# path would be unreachable: with no project there is no secret and no JWKS, so
# every token would fail and nobody could post.
#
# This is only reachable when Supabase is entirely absent. It cannot be turned
# on in a deployed environment by setting a flag, because there is no flag.
# ---------------------------------------------------------------------------

def offline():
    return not os.environ.get("SUPABASE_URL", "").strip()


_DEV_PREFIX = "dev."


def dev_token(user_id):
    """A token the offline branch accepts. Used by the dev sign-in and tests."""
    return _DEV_PREFIX + base64.urlsafe_b64encode(user_id.encode()).decode().rstrip("=")


def identify(request):
    """(user_id, claims) for a request, or AuthError."""
    token = bearer(request)
    if offline() and token.startswith(_DEV_PREFIX):
        try:
            user_id = _b64(token[len(_DEV_PREFIX):]).decode()
        except (ValueError, UnicodeDecodeError):
            raise AuthError("token")
        if not user_id:
            raise AuthError("sub")
        return user_id, {"sub": user_id, "role": "authenticated"}
    claims = verify(token)
    return claims["sub"], claims
