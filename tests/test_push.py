"""Stage 6: notifications that reach people outside the app.

Web Push framing (RFC 8291 encryption, RFC 8292 VAPID), the dispatcher's rules
(who is pushed, when, with what words) and Q34's quiet posts, which stay in the
app. No push service is contacted: a fake client takes the POSTs and the test
decrypts them with the browser's half of the keys. Everybody here is made up.
"""

import json
import os
import struct
import threading
import time
from collections import Counter
from datetime import datetime, timedelta, timezone

import pytest
from cryptography.hazmat.primitives import hashes, hmac
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

import app as application
from conftest import BOOKKEEPING, CAMPING_A, CAMPING_B, CAMPING_C
from core import quiet, webpush
from core.config import (
    PUSH_FRESH_MINUTES,
    QUIET_POST_MIN_HOURS,
    QUIET_POST_PER_POST,
)

ENDPOINT = "https://fcm.googleapis.com/fcm/send/test-endpoint"


# --------------------------------------------------------------------------
# a browser's half of the keys, and a push service that only records
# --------------------------------------------------------------------------

class Browser:
    """What PushManager.subscribe() makes: a key pair and an auth secret."""

    def __init__(self, endpoint=ENDPOINT):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.auth = os.urandom(16)
        self.endpoint = endpoint

    @property
    def p256dh(self):
        return webpush.b64u(webpush._public_bytes(self.key))

    def subscription(self):
        return {"endpoint": self.endpoint,
                "keys": {"p256dh": self.p256dh, "auth": webpush.b64u(self.auth)}}

    def decrypt(self, body):
        """RFC 8291 from the receiving side, written apart from core/webpush."""
        salt, record_size, id_length = body[:16], *struct.unpack("!IB", body[16:21])
        sender = body[21:21 + id_length]
        record = body[21 + id_length:]
        assert record_size == 4096 and len(record) <= record_size
        shared = self.key.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(
            ec.SECP256R1(), sender))
        mine = webpush._public_bytes(self.key)
        ikm = _mac(_mac(self.auth, shared), b"WebPush: info\x00" + mine + sender + b"\x01")
        prk = _mac(salt, ikm)
        cek = _mac(prk, b"Content-Encoding: aes128gcm\x00\x01")[:16]
        nonce = _mac(prk, b"Content-Encoding: nonce\x00\x01")[:12]
        plain = AESGCM(cek).decrypt(nonce, record, None).rstrip(b"\x00")
        assert plain.endswith(b"\x02")  # the last (and only) record
        return json.loads(plain[:-1].decode("utf-8"))


def _mac(key, data):
    mac = hmac.HMAC(key, hashes.SHA256())
    mac.update(data)
    return mac.finalize()


class Reply:
    def __init__(self, status_code):
        self.status_code = status_code


class PushService:
    """Stands in for httpx.Client: records every POST, answers `status`."""

    def __init__(self, status=201):
        self.status = status
        self.sent = []

    def post(self, url, content, headers, timeout):
        self.sent.append({"url": url, "body": content, "headers": headers})
        return Reply(self.status)


def subscribe(client, person, browser=None):
    browser = browser or Browser()
    response = client.post("/api/push/subscribe", json=browser.subscription(),
                           headers=person.headers)
    assert response.status_code == 200, response.text
    return browser


def dispatch(service=None, now=None):
    service = service or PushService()
    tally = application.dispatch_pushes(now=now, client=service)
    return service, tally


def opened(browser, service, kind):
    """What `browser` shows for one category."""
    messages = [browser.decrypt(sent["body"]) for sent in service.sent
                if sent["url"] == browser.endpoint]
    assert {message["kind"] for message in messages} <= {kind}, messages
    return [message for message in messages if message["kind"] == kind]


# --------------------------------------------------------------------------
# framing
# --------------------------------------------------------------------------

def test_encryption_matches_the_rfc_8291_example():
    # Appendix A of RFC 8291, every value as printed there.
    body = webpush.encrypt(
        b"When I grow up, I want to be a watermelon",
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        "BTBZMqHH6r4Tts7J_aSIgg",
        salt=webpush.unb64u("DGv6ra1nlYgDCS1FRnbzlw"),
        server_key=webpush.private_key("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
    )
    assert webpush.b64u(body) == (
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYW"
        "AmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxs"
        "j_Qulcy4a-fN")


def test_a_message_comes_back_out_with_the_browsers_keys():
    browser = Browser()
    message = {"title": "島「焚き火」", "body": "あ" * 300}
    body = webpush.encrypt(json.dumps(message, ensure_ascii=False).encode("utf-8"),
                           browser.p256dh, webpush.b64u(browser.auth))
    assert browser.decrypt(body) == message


def test_a_payload_too_big_for_one_record_is_refused():
    browser = Browser()
    webpush.encrypt(b"x" * webpush.MAX_PAYLOAD, browser.p256dh, webpush.b64u(browser.auth))
    with pytest.raises(ValueError):
        webpush.encrypt(b"x" * (webpush.MAX_PAYLOAD + 1), browser.p256dh, webpush.b64u(browser.auth))


def test_the_vapid_token_is_signed_for_that_push_service():
    public, private = webpush.new_keys()
    header = webpush.vapid_header("https://web.push.apple.com/abc", public, private,
                                  "https://islands.example", now=1_000_000)
    token, key = header.removeprefix("vapid t=").split(", k=")
    assert key == public
    head, claims, signature = token.split(".")
    assert json.loads(webpush.unb64u(head)) == {"typ": "JWT", "alg": "ES256"}
    claims = json.loads(webpush.unb64u(claims))
    assert claims["aud"] == "https://web.push.apple.com"
    assert claims["sub"] == "https://islands.example"
    assert 0 < claims["exp"] - 1_000_000 <= 24 * 3600
    raw = webpush.unb64u(signature)
    der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    verifier = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), webpush.unb64u(public))
    verifier.verify(der, f"{head}.{token.split('.')[1]}".encode("ascii"), ec.ECDSA(hashes.SHA256()))


def test_a_key_pair_is_checked_before_use():
    public, private = webpush.new_keys()
    other_public, _ = webpush.new_keys()
    assert webpush.keys_match(public, private)
    assert not webpush.keys_match(other_public, private)
    assert not webpush.keys_match(public, "not-a-key")


@pytest.mark.parametrize("url, allowed", [
    ("https://fcm.googleapis.com/fcm/send/abc", True),
    ("https://updates.push.services.mozilla.com/wpush/v2/abc", True),
    ("https://web.push.apple.com/abc", True),
    ("https://wns2-db5p.notify.windows.com/w/?token=abc", True),
    ("https://push.apple.com/abc", False),
    ("http://fcm.googleapis.com/fcm/send/abc", False),
    ("https://fcm.googleapis.com:8443/fcm/send/abc", False),
    ("https://user@fcm.googleapis.com/fcm/send/abc", False),
    ("https://fcm.googleapis.com.evil.example/abc", False),
    ("https://evil.example/?fcm.googleapis.com", False),
    ("https://169.254.169.254/latest/meta-data", False),
    ("https://localhost/abc", False),
    ("not a url", False),
])
def test_only_known_push_services_are_posted_to(url, allowed):
    assert webpush.allowed_endpoint(url) is allowed


def test_a_topic_is_short_and_header_safe():
    topic = webpush.topic_for("reaction-" + "f" * 100)
    assert len(topic) <= 32
    assert set(topic) <= set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")


# --------------------------------------------------------------------------
# keys and subscriptions
# --------------------------------------------------------------------------

def test_the_server_makes_its_keys_once_and_serves_the_public_half(fresh_client):
    first = fresh_client.get("/api/config").json()["push"]
    second = fresh_client.get("/api/config").json()["push"]
    stored = application.state["store"].get_push_config()
    assert first["public_key"] == second["public_key"] == stored["vapid_public"]
    assert webpush.keys_match(stored["vapid_public"], stored["vapid_private"])
    assert first["presence_seconds"] < first["presence_hold"] <= 120


def test_the_worker_and_the_manifest_are_served_from_the_root(fresh_client):
    worker = fresh_client.get("/sw.js")
    assert worker.status_code == 200
    assert "javascript" in worker.headers["content-type"]
    assert "push" in worker.text and "notificationclick" in worker.text
    manifest = fresh_client.get("/manifest.webmanifest")
    assert manifest.status_code == 200
    assert manifest.headers["content-type"].startswith("application/manifest+json")
    body = manifest.json()
    assert body["display"] == "standalone" and body["scope"] == "/"
    purposes = {icon.get("purpose", "any") for icon in body["icons"]}
    assert {"any", "maskable"} <= purposes
    # Every icon it names (and the ones the page and the worker name) exists.
    named = [icon["src"] for icon in body["icons"]] + [
        "/static/img/icons/apple-touch-icon.png", "/static/img/icons/badge-96.png"]
    for src in named:
        assert fresh_client.get(src).status_code == 200, src


def test_a_pair_that_does_not_fit_turns_push_off_and_is_left_alone(fresh_client, people):
    store = application.state["store"]
    public, _ = webpush.new_keys()
    _, private = webpush.new_keys()
    store._push_config.update({"vapid_public": public, "vapid_private": private})
    assert application.push_keys() is None
    assert fresh_client.get("/api/config").json()["push"]["public_key"] is None
    author = people("keys-a@example.test", "かく人")
    reader = people("keys-b@example.test", "よむ人")
    subscribe(fresh_client, author)
    post = author.post(CAMPING_A)
    reader.react(post["id"], "like")
    service, tally = dispatch()
    assert service.sent == [] and tally["no_keys"] >= 1
    assert store.get_push_config()["vapid_private"] == private


def test_subscribing_checks_the_endpoint_and_the_keys(fresh_client, people):
    person = people("sub@example.test", "とうろく")
    good = Browser().subscription()
    cases = [
        {**good, "endpoint": "https://evil.example/push"},
        {**good, "keys": {**good["keys"], "p256dh": webpush.b64u(b"\x04" + b"\x01" * 63)}},
        {**good, "keys": {**good["keys"], "p256dh": webpush.b64u(b"\x02" + b"\x01" * 64)}},
        {**good, "keys": {**good["keys"], "auth": webpush.b64u(b"\x01" * 15)}},
        {**good, "keys": {**good["keys"], "auth": "!!!"}},
    ]
    for body in cases:
        response = fresh_client.post("/api/push/subscribe", json=body, headers=person.headers)
        assert response.status_code == 422, body
    assert fresh_client.post("/api/push/subscribe", json=good).status_code == 401
    assert fresh_client.post("/api/push/subscribe", json=good,
                             headers=person.headers).status_code == 200
    rows = application.state["store"].push_subscriptions([person.id])
    assert [row["endpoint"] for row in rows] == [good["endpoint"]]


def test_only_the_owner_can_drop_a_subscription(fresh_client, people):
    owner = people("own@example.test", "もちぬし")
    stranger = people("other@example.test", "よそのひと")
    browser = subscribe(fresh_client, owner)
    response = fresh_client.post("/api/push/unsubscribe", json={"endpoint": browser.endpoint},
                                 headers=stranger.headers)
    assert response.json() == {"removed": False}
    response = fresh_client.post("/api/push/unsubscribe", json={"endpoint": browser.endpoint},
                                 headers=owner.headers)
    assert response.json() == {"removed": True}
    assert application.state["store"].push_subscriptions([owner.id]) == []


def test_the_poke_needs_no_sign_in_and_sends_nothing_by_itself(fresh_client):
    response = fresh_client.post("/api/push/dispatch")
    assert response.status_code == 202


# --------------------------------------------------------------------------
# who is pushed, with what words
# --------------------------------------------------------------------------

def test_a_reaction_reaches_the_authors_browser(fresh_client, people):
    author = people("react-a@example.test", "かく人")
    reader = people("react-b@example.test", "よむ人")
    browser = subscribe(fresh_client, author)
    post = author.post(CAMPING_A)
    reader.react(post["id"], "like")

    service, tally = dispatch()
    assert tally == {"sent": len(service.sent)}
    [message] = opened(browser, service, "reaction")
    [sent] = [sent for sent in service.sent
              if browser.decrypt(sent["body"])["kind"] == "reaction"]
    assert sent["url"] == ENDPOINT
    assert sent["headers"]["Content-Encoding"] == "aes128gcm"
    assert sent["headers"]["Authorization"].startswith("vapid t=")
    assert sent["headers"]["TTL"] == str(24 * 3600)
    assert message["title"] == "よむ人"
    assert message["body"] == "あなたの投稿に「いいね」しました。"
    assert message["tag"] == f"reaction-{post['id']}"
    assert sent["headers"]["Topic"] == webpush.topic_for(message["tag"])
    assert message["url"] == "/#/notifications" and message["kind"] == "reaction"

    again, tally = dispatch()
    assert again.sent == [] and not tally


def test_reactions_close_together_replace_one_another(fresh_client, people):
    author = people("group-a@example.test", "かく人")
    first = people("group-b@example.test", "ひとりめ")
    second = people("group-c@example.test", "ふたりめ")
    browser = subscribe(fresh_client, author)
    post = author.post(CAMPING_A)
    first.react(post["id"], "like")
    dispatch()
    second.react(post["id"], "help")
    service, _ = dispatch()
    [message] = opened(browser, service, "reaction")
    assert message["title"] == "ふたりめ ほか1人"
    assert message["body"] == "あなたの投稿に反応しました。"
    assert message["tag"] == f"reaction-{post['id']}"


def test_messages_and_replies_say_who_but_not_what(fresh_client, people):
    author = people("talk-a@example.test", "かく人")
    reader = people("talk-b@example.test", "よむ人")
    browser = subscribe(fresh_client, author)
    post = author.post(CAMPING_A)
    reader.comment(post["id"], "秘密の待ち合わせ場所は駅の北口です")
    service, _ = dispatch()
    [message] = opened(browser, service, "reply")
    assert message["title"] == "よむ人"
    assert message["body"] == "あなたの投稿にメッセージを送りました。"
    for sent in service.sent:
        assert "北口" not in json.dumps(browser.decrypt(sent["body"]), ensure_ascii=False)


def test_nobody_is_pushed_while_the_app_is_on_their_screen(fresh_client, people):
    author = people("seen-a@example.test", "かく人")
    reader = people("seen-b@example.test", "よむ人")
    subscribe(fresh_client, author)
    post = author.post(CAMPING_A)
    assert fresh_client.post("/api/local/presence", json={"seconds": 75},
                             headers=author.headers).status_code == 200
    reader.react(post["id"], "like")
    service, _ = dispatch()
    assert service.sent == []
    assert author.unread(["like"])  # the band and the list still have it

    fresh_client.post("/api/local/presence", json={"seconds": 0}, headers=author.headers)
    reader.react(post["id"], "join")
    service, _ = dispatch()
    assert len(service.sent) == 1


def test_a_kind_switched_off_for_push_stays_in_the_list(fresh_client, people):
    author = people("quiet-a@example.test", "かく人")
    reader = people("quiet-b@example.test", "よむ人")
    browser = subscribe(fresh_client, author)
    response = fresh_client.put("/api/notification-settings", headers=author.headers, json={
        "settings": [{"category": "reaction", "push": False, "in_app": True},
                     {"category": "connection", "push": False, "in_app": True}]})
    assert response.status_code == 200, response.text
    post = author.post(CAMPING_A)
    reader.react(post["id"], "like")
    reader.comment(post["id"], "いいですね")
    service, _ = dispatch()
    kinds = [browser.decrypt(sent["body"])["kind"] for sent in service.sent]
    assert kinds == ["reply"]  # the message, not the like
    assert author.unread(["like"]) and not author.unread(["connection"])


def test_old_news_is_marked_but_not_pushed(fresh_client, people):
    author = people("old-a@example.test", "かく人")
    reader = people("old-b@example.test", "よむ人")
    subscribe(fresh_client, author)
    post = author.post(CAMPING_A)
    reader.react(post["id"], "like")
    later = datetime.now(timezone.utc) + timedelta(minutes=PUSH_FRESH_MINUTES + 1)
    service, _ = dispatch(now=later)
    assert service.sent == []
    service, _ = dispatch()
    assert service.sent == []


def test_a_subscription_the_service_has_dropped_is_forgotten(fresh_client, people):
    author = people("gone-a@example.test", "かく人")
    reader = people("gone-b@example.test", "よむ人")
    subscribe(fresh_client, author)
    post = author.post(CAMPING_A)
    reader.react(post["id"], "like")
    _, tally = dispatch(PushService(status=410))
    assert tally == {"gone": 1}
    assert application.state["store"].push_subscriptions([author.id]) == []


def test_every_browser_of_a_person_is_pushed(fresh_client, people):
    author = people("two-a@example.test", "かく人")
    reader = people("two-b@example.test", "よむ人")
    phone = subscribe(fresh_client, author, Browser("https://web.push.apple.com/phone"))
    laptop = subscribe(fresh_client, author, Browser())
    post = author.post(CAMPING_A)
    reader.react(post["id"], "like")
    service, _ = dispatch()
    by_url = {sent["url"]: sent["body"] for sent in service.sent}
    assert phone.decrypt(by_url[phone.endpoint])["title"] == "よむ人"
    assert laptop.decrypt(by_url[laptop.endpoint])["title"] == "よむ人"


def test_an_island_change_is_named_after_the_island(fresh_client, people):
    person = people("isle@example.test", "しまびと")
    browser = subscribe(fresh_client, person)
    application.state["store"].insert_notifications([{
        "recipient_id": person.id, "actor_id": None, "type": "island",
        "payload": {"kind": "rename", "cause": "新しい言葉が増えて名前が変わりました", "name": "焚き火"},
    }])
    service, _ = dispatch()
    [message] = [browser.decrypt(sent["body"]) for sent in service.sent]
    assert message["title"] == "島「焚き火」"
    assert message["body"] == "新しい言葉が増えて名前が変わりました。"
    assert message["kind"] == "island"


def test_a_quiet_post_is_never_pushed(fresh_client, people):
    author = people("never-a@example.test", "かく人")
    person = people("never-b@example.test", "ちかくの人")
    subscribe(fresh_client, person)
    post = author.post(CAMPING_A)
    application.state["store"].insert_notifications([{
        "recipient_id": person.id, "actor_id": author.id, "post_id": post["id"],
        "type": "quiet_post", "payload": {"message": quiet.MESSAGE},
    }])
    service, _ = dispatch()
    assert service.sent == []
    assert person.unread(["quiet_post"])


def test_one_dispatcher_runs_and_a_poke_meanwhile_asks_for_one_more_pass(monkeypatch):
    started, release, passes = threading.Event(), threading.Event(), []

    def slow_pass(*_args, **_kwargs):
        passes.append(time.monotonic())
        started.set()
        release.wait(5)

    monkeypatch.setattr(application, "PUSH_AUTO", True)
    monkeypatch.setattr(application, "PUSH_MIN_GAP_SECONDS", 0.0)
    monkeypatch.setattr(application, "dispatch_pushes", slow_pass)
    assert application.poke_push_dispatch() is True
    assert started.wait(5)
    assert application.poke_push_dispatch() is False
    assert application.poke_push_dispatch() is False
    release.set()
    deadline = time.monotonic() + 5
    while application._push_state["running"] and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not application._push_state["running"]
    assert len(passes) == 2


# --------------------------------------------------------------------------
# Q34: quiet posts, in the app only
# --------------------------------------------------------------------------

NOW = datetime(2026, 10, 7, 12, 0, tzinfo=timezone.utc)


def _post(post_id, author, x, y, hours=30, **counts):
    return {"id": post_id, "author_id": author, "x": x, "y": y,
            "created_at": (NOW - timedelta(hours=hours)).isoformat(), **counts}


def test_a_post_is_quiet_with_no_reaction_between_a_day_and_a_week():
    assert not quiet.is_quiet(_post("p", "a", 0, 0, hours=QUIET_POST_MIN_HOURS - 1), NOW)
    assert quiet.is_quiet(_post("p", "a", 0, 0, hours=QUIET_POST_MIN_HOURS), NOW)
    assert quiet.is_quiet(_post("p", "a", 0, 0, hours=7 * 24), NOW)
    assert not quiet.is_quiet(_post("p", "a", 0, 0, hours=7 * 24 + 1), NOW)
    for column in quiet.REACTION_COLUMNS:
        assert not quiet.is_quiet(_post("p", "a", 0, 0, **{column: 1}), NOW)


def test_near_islands_are_its_own_and_the_closest_others():
    islands = [{"cx": 0, "cy": 0}, {"cx": 50, "cy": 0}, {"cx": 10, "cy": 0},
               {"cx": 20, "cy": 0}, {"cx": None, "cy": None}]
    assert quiet.near_islands((0, 0), 0, islands) == [0, 2, 3]
    assert quiet.near_islands((49, 0), None, islands) == [1, 3, 2]


def test_candidates_are_nearest_people_but_never_the_author():
    posts = [_post("quiet", "author", 0, 0), _post("mine2", "author", 0.1, 0, hours=1),
             _post("near", "near", 1, 0, hours=1), _post("far", "far", 9, 0, hours=1),
             _post("far2", "far", 30, 0, hours=1), _post("away", "away", 500, 0, hours=1)]
    islands = [{"cx": 0, "cy": 0, "post_ids": ["quiet", "mine2", "near"]},
               {"cx": 20, "cy": 0, "post_ids": ["far", "far2"]},
               {"cx": 500, "cy": 0, "post_ids": ["away"]},
               {"cx": 400, "cy": 0, "post_ids": []}]
    found = quiet.candidates(posts, islands, NOW)
    assert [item["post_id"] for item in found] == ["quiet"]
    assert found[0]["people"] == ["near", "far"]
    assert quiet.candidates(posts, islands, NOW, already={"quiet"}) == []


def test_choose_tells_visitors_once_a_day_and_three_per_post():
    found = [{"post_id": "p1", "author_id": "a", "people": ["b", "c", "d", "e", "f"]},
             {"post_id": "p2", "author_id": "a", "people": ["b", "c", "g"]}]
    rows = quiet.choose(found, visitors={"b", "c", "d", "e", "g"}, told_recently=["e"])
    assert [(row["post_id"], row["recipient_id"]) for row in rows] == [
        ("p1", "b"), ("p1", "c"), ("p1", "d"), ("p2", "g")]
    assert len([row for row in rows if row["post_id"] == "p1"]) == QUIET_POST_PER_POST
    assert all(row["type"] == "quiet_post" and row["actor_id"] == "a" for row in rows)
    # It reads as a recommendation; nothing says the post went unanswered.
    assert "反応" not in quiet.MESSAGE and "ない" not in quiet.MESSAGE


def test_quiet_posts_reach_people_nearby_once(fresh_client, people):
    author = people("qp-a@example.test", "かく人")
    near = people("qp-b@example.test", "ちかい人")
    also = people("qp-c@example.test", "となりの人")
    away = people("qp-d@example.test", "こない人")
    post = author.post(CAMPING_A)
    near.post(CAMPING_B)
    also.post(CAMPING_C)
    away.post(BOOKKEEPING)
    store = application.state["store"]
    for person in (author, near, also):
        store.touch_last_seen(person.id)
    application.invalidate_islands()
    later = datetime.now(timezone.utc) + timedelta(hours=QUIET_POST_MIN_HOURS + 1)

    rows = application.notify_quiet_posts(now=later)
    mine = [row for row in rows if row["post_id"] == post["id"]]
    assert {row["recipient_id"] for row in mine} <= {near.id, also.id}
    assert mine, rows
    # Nobody is shown their own post; the author may well be shown another.
    assert all(row["recipient_id"] != row["actor_id"] for row in rows)
    assert all(row["recipient_id"] != away.id for row in rows)  # never came by
    assert max(Counter(row["recipient_id"] for row in rows).values()) == 1
    told = mine[0]["recipient_id"]
    inbox = [row for row in store.list_notifications(told) if row["type"] == "quiet_post"]
    assert inbox and inbox[0]["payload"] == {"message": quiet.MESSAGE}

    # Each post is shown once. (The once-a-day cap is choose()'s, tested above;
    # here the rows carry today's time while `later` is a day ahead.)
    again = application.notify_quiet_posts(now=later)
    assert not {row["post_id"] for row in again} & {row["post_id"] for row in rows}



# --------------------------------------------------------------------------
# 2026-10-29: つながりの通知 ('match'). One line each in the app; the push waits and bundles
# --------------------------------------------------------------------------

MATCH_REASON = "あなたの経験が役に立ちそうな困りごとが投稿されました"
WINDOW = timedelta(minutes=application.MATCH_PUSH_WINDOW_MINUTES)


_match_clock = [0]


def write_match(recipient, actor, post, reason=MATCH_REASON, kind="need_have"):
    store = application.state["store"]
    [row] = store.insert_notifications([{
        "recipient_id": recipient.id, "actor_id": actor.id, "post_id": post["id"], "type": "match",
        "payload": {"kind": kind, "other_post": "q", "reason": reason},
    }])
    # The clock ticks coarsely: give every row its own time so "the newest" is well defined.
    _match_clock[0] += 1
    store._notifications[row["id"]]["created_at"] = (
        datetime.now(timezone.utc) - timedelta(seconds=60) + timedelta(seconds=_match_clock[0] % 50)).isoformat()
    return row


def sent_messages(browser, service):
    return [browser.decrypt(sent["body"]) for sent in service.sent if sent["url"] == browser.endpoint]


@pytest.fixture
def match_world(fresh_client, people):
    class World:
        pass

    w = World()
    w.client = fresh_client
    w.reader = people("m-reader@example.test", "よむ人")
    w.first = people("m-first@example.test", "いちばん")
    w.second = people("m-second@example.test", "にばん")
    w.third = people("m-third@example.test", "さんばん")
    w.browser = subscribe(fresh_client, w.reader)
    w.posts = {name: getattr(w, name).post(CAMPING_A, prompt="help") for name in ("first", "second", "third")}
    return w


def test_a_match_push_names_the_writer_and_the_reason_but_not_the_post(match_world):
    w = match_world
    write_match(w.reader, w.first, w.posts["first"])
    service, tally = dispatch()
    assert tally == {"sent": 1}
    [message] = sent_messages(w.browser, service)
    assert message["title"] == "いちばんさん"
    assert message["body"] == MATCH_REASON
    assert message["url"] == f"/#/map?post={w.posts['first']['id']}"
    assert message["kind"] == "reaction"
    assert CAMPING_A not in json.dumps(message, ensure_ascii=False)
    assert message["tag"].startswith("match-")


def test_a_name_that_already_ends_in_san_is_not_doubled(fresh_client, people):
    reader, writer = people("san-r@example.test", "よむ人"), people("san-w@example.test", "たなかさん")
    browser = subscribe(fresh_client, reader)
    write_match(reader, writer, writer.post(CAMPING_A, prompt="help"))
    service, _ = dispatch()
    assert sent_messages(browser, service)[0]["title"] == "たなかさん"


def test_a_match_inside_the_window_waits_and_goes_out_after_it(match_world):
    w = match_world
    write_match(w.reader, w.first, w.posts["first"])
    service, _ = dispatch()
    assert len(service.sent) == 1
    held = write_match(w.reader, w.second, w.posts["second"], reason="あなたの困りごとに、経験のある人が投稿しました")
    service, tally = dispatch()
    assert service.sent == [] and tally["held_match"] == 1
    assert w.reader.unread(["match"])                                  # the app list has it already
    assert held["id"] in application.state["store"]._push_pending     # not marked sent
    later = datetime.now(timezone.utc) + WINDOW + timedelta(minutes=1)
    service, tally = dispatch(now=later)
    [message] = sent_messages(w.browser, service)
    assert message["title"] == "にばんさん" and message["body"] == "あなたの困りごとに、経験のある人が投稿しました"
    again, tally = dispatch(now=later)
    assert again.sent == [] and not tally


def test_the_window_is_five_minutes(match_world):
    assert application.MATCH_PUSH_WINDOW_MINUTES == 5
    w = match_world
    write_match(w.reader, w.first, w.posts["first"])
    dispatch()
    write_match(w.reader, w.second, w.posts["second"])
    inside = datetime.now(timezone.utc) + timedelta(minutes=4)
    service, tally = dispatch(now=inside)
    assert service.sent == [] and tally["held_match"] == 1


def test_several_waiting_matches_go_out_as_one_push(match_world):
    w = match_world
    write_match(w.reader, w.first, w.posts["first"])
    dispatch()
    write_match(w.reader, w.second, w.posts["second"])
    dispatch()
    write_match(w.reader, w.third, w.posts["third"])
    dispatch()
    service, tally = dispatch(now=datetime.now(timezone.utc) + WINDOW + timedelta(minutes=1))
    [message] = sent_messages(w.browser, service)
    assert message["title"] == "新しいつながり"
    assert message["body"] == "さんばんさん ほか1人の投稿が、あなたの投稿とつながりました"
    assert message["url"] == "/#/notifications" and message["kind"] == "reaction"
    assert tally == {"sent": 1}
    assert len(w.reader.inbox(["match"])) == 3                  # the app keeps one line each


def test_matches_that_arrive_together_are_bundled_at_once(match_world):
    w = match_world
    for name in ("first", "second", "third"):
        write_match(w.reader, getattr(w, name), w.posts[name])
    service, _ = dispatch()
    [message] = sent_messages(w.browser, service)
    assert message["title"] == "新しいつながり"
    assert message["body"] == "さんばんさん ほか2人の投稿が、あなたの投稿とつながりました"


def test_the_same_writer_twice_is_not_counted_as_more_people(match_world):
    w = match_world
    other_post = w.first.post(CAMPING_C, prompt="help")
    write_match(w.reader, w.first, w.posts["first"])
    write_match(w.reader, w.first, other_post)
    service, _ = dispatch()
    [message] = sent_messages(w.browser, service)
    assert message["title"] == "新しいつながり"
    assert message["body"] == "いちばんさんの投稿が、あなたの投稿とつながりました"


def test_held_matches_are_per_person_and_do_not_hold_other_pushes(match_world, people):
    w = match_world
    other = people("m-other@example.test", "べつの人")
    other_browser = subscribe(w.client, other, Browser("https://fcm.googleapis.com/fcm/send/other"))
    write_match(w.reader, w.first, w.posts["first"])
    dispatch()
    write_match(w.reader, w.second, w.posts["second"])
    write_match(other, w.second, w.posts["second"])                    # nothing was sent to `other` yet
    mine = w.reader.post(CAMPING_B, prompt="past")
    w.third.react(mine["id"], "like")                                  # a like is not held back
    service, tally = dispatch()
    assert tally["held_match"] == 1
    assert [message["body"] for message in sent_messages(w.browser, service)] == ["あなたの投稿に「いいね」しました。"]
    [message] = sent_messages(other_browser, service)
    assert message["title"] == "にばんさん"


def test_matches_follow_the_reaction_push_switch(match_world):
    w = match_world
    response = w.client.put("/api/notification-settings", headers=w.reader.headers, json={
        "settings": [{"category": "reaction", "push": False, "in_app": True}]})
    assert response.status_code == 200, response.text
    write_match(w.reader, w.first, w.posts["first"])
    service, tally = dispatch()
    assert service.sent == [] and "held_match" not in tally
    assert w.reader.unread(["match"])                                  # still in the list
    w.client.put("/api/notification-settings", headers=w.reader.headers, json={
        "settings": [{"category": "reaction", "push": True, "in_app": True}]})
    write_match(w.reader, w.second, w.posts["second"])
    # (the first row was taken when it was switched off, so the window counts from then)
    service, _ = dispatch(now=datetime.now(timezone.utc) + WINDOW + timedelta(minutes=1))
    assert len(sent_messages(w.browser, service)) == 1


def test_a_match_that_waited_too_long_is_dropped(match_world):
    w = match_world
    write_match(w.reader, w.first, w.posts["first"])
    dispatch()
    write_match(w.reader, w.second, w.posts["second"])
    dispatch()                                                         # held
    service, _ = dispatch(now=datetime.now(timezone.utc) + timedelta(minutes=PUSH_FRESH_MINUTES + 1))
    assert service.sent == []
    service, _ = dispatch()
    assert service.sent == []


def test_no_timer_is_set_when_push_is_off():
    assert application.schedule_push_poke(5) is False                 # ISLANDS_AUTO_PUSH=0 in the tests


def test_the_timer_wakes_the_dispatcher_once(monkeypatch):
    woken = []

    class Instant:
        daemon = False

        def __init__(self, seconds, function):
            self.function = function

        def start(self):
            self.function()

    monkeypatch.setattr(application, "PUSH_AUTO", True)
    monkeypatch.setattr(application, "poke_push_dispatch", lambda: woken.append(1))
    monkeypatch.setattr(application.threading, "Timer", Instant)
    assert application.schedule_push_poke(5) is True
    assert woken == [1]
    assert application._push_timer["set"] is False
