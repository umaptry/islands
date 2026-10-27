"""2026-10-20: prompts, sign-up deadline / capacity and 受付終了.

Local mode (MemoryStore behind the API) plus a SupabaseStore whose database has
not had the SQL yet. Everybody here is made up.
"""

from datetime import date, datetime, timedelta, timezone

import pytest

import app as application
from conftest import CAMPING_A
from core import post_extras
from core.config import EXAMPLE_POSTS, EXTRA_PROMPTS, TAGS
from core.store import StoreError, SupabaseStore

RECRUIT = "参加者募集中"
JST = timezone(timedelta(hours=9))


def jst_today():
    return datetime.now(JST).date()


def day(offset):
    return (jst_today() + timedelta(days=offset)).isoformat()


# --------------------------------------------------------------------------
# the examples and the extra prompts
# --------------------------------------------------------------------------

def test_there_are_three_examples_that_fit_a_post():
    assert len(EXAMPLE_POSTS) == 3
    assert len(set(EXAMPLE_POSTS)) == 3
    assert all(1 <= len(text) <= application.MAX_TEXT_LENGTH for text in EXAMPLE_POSTS)


def test_every_extra_prompt_has_its_own_example_sentence():
    examples = [item["example"] for item in EXTRA_PROMPTS]
    assert all(1 <= len(text) <= application.MAX_TEXT_LENGTH for text in examples)
    assert len(set(examples)) == len(EXTRA_PROMPTS)
    # Not one of the tryout examples above it on the first post.
    assert not set(examples) & set(EXAMPLE_POSTS)


def test_a_prompt_that_comes_with_a_tag_names_a_real_one(client):
    # 困ってること ticks 助けてほしい at step ③ (the screen reads the tag from /api/config).
    data = client.get("/api/config").json()
    tagged = {item["key"]: item["tag"] for item in data["extra_prompts"] if item.get("tag")}
    assert tagged == {"help": "助けてほしい"}
    assert set(tagged.values()) <= set(data["tags"])


def test_config_carries_the_extra_prompts_and_the_feature_flag(client):
    data = client.get("/api/config").json()
    assert [{"key": item["key"], "text": item["text"]} for item in data["extra_prompts"]] == [
        {"key": "past", "text": "昔がんばってたこと"},
        {"key": "now", "text": "最近はまってること"},
        {"key": "future", "text": "今度やってみたいこと"},
        {"key": "help", "text": "困ってること"},
    ]
    assert data["extra_prompts"] == [dict(item) for item in EXTRA_PROMPTS]
    assert data["features"] == {"post_extras": True, "talk": True, "communities": True, "members_only": False,
                                "share": False}


def test_config_carries_the_first_post_starters_keyed_like_the_extra_prompts(client):
    data = client.get("/api/config").json()
    assert [item["text"] for item in data["post_starters"]] == [
        "昔がんばってたこと", "最近はまってること", "今度やってみたいこと", "困ってること"]
    # the chip names the prompt; the box is never filled with it
    assert [item["text"] for item in data["post_starters"]] == [item["text"] for item in data["extra_prompts"]]
    assert next(item for item in data["extra_prompts"] if item["key"] == "now")["example"] == (
        "仕事帰りにレイトショーを観るのにはまっています。洋画が多めです。おすすめがあれば教えてください。")
    assert [item["key"] for item in data["post_starters"]] == [item["key"] for item in data["extra_prompts"]]


def test_health_reports_the_columns_and_ready_does_not_depend_on_them(client):
    data = client.get("/api/health").json()
    assert data["post_extras_ready"] is True


# --------------------------------------------------------------------------
# the pure rules
# --------------------------------------------------------------------------

def test_a_deadline_lasts_until_the_end_of_the_day_in_japan():
    last = date(2026, 10, 20)
    at = lambda hour, minute: datetime(2026, 10, 20, hour, minute, tzinfo=JST)  # noqa: E731
    assert post_extras.closed_state(last, None, 0, now=at(23, 59)) is None
    assert post_extras.closed_state("2026-10-20", None, 0, now=at(23, 59)) is None
    next_day = datetime(2026, 10, 21, 0, 0, tzinfo=JST)
    assert post_extras.closed_state("2026-10-20", None, 0, now=next_day) == "deadline"


def test_full_and_deadline_and_open():
    assert post_extras.closed_state(None, 3, 3) == "full"
    assert post_extras.closed_state(None, 3, 2) is None
    assert post_extras.closed_state(None, None, 500) is None
    assert post_extras.closed_state(day(-1), 3, 3) == "deadline"


def test_the_deadline_range_and_the_capacity_range():
    assert post_extras.clean_deadline(day(0)) == day(0)
    assert post_extras.clean_deadline(day(365)) == day(365)
    for bad in (day(-1), day(366), "2026-13-01", "来週", "2026/10/20"):
        with pytest.raises(ValueError):
            post_extras.clean_deadline(bad)
    assert post_extras.clean_deadline(day(-5), keep=day(-5)) == day(-5)
    assert post_extras.clean_deadline(None) is None
    assert post_extras.clean_capacity(1) == 1 and post_extras.clean_capacity(999) == 999
    for bad in (0, 1000, -3, 2.5, True, "many"):
        with pytest.raises(ValueError):
            post_extras.clean_capacity(bad)
    with pytest.raises(ValueError):
        post_extras.clean_prompt("someday")
    assert post_extras.clean_prompt("future") == "future"
    assert post_extras.clean_prompt("help") == "help"


# --------------------------------------------------------------------------
# posting and editing (local mode)
# --------------------------------------------------------------------------

def test_a_prompt_and_the_sign_up_fields_are_saved_and_returned(fresh_client, people):
    host = people("host-extras@example.test", "主催")
    made = host.post(CAMPING_A, tags=[RECRUIT], prompt="now",
                     recruit_deadline=day(3), recruit_capacity=4)
    assert made["prompt"] == "now"
    assert made["recruit_deadline"] == day(3)
    assert made["recruit_capacity"] == 4
    assert made["recruit_closed"] is None
    mine = fresh_client.get(f"/api/local/posts?author={host.id}").json()["posts"][0]
    assert (mine["prompt"], mine["recruit_capacity"], mine["recruit_closed"]) == ("now", 4, None)
    on_map = fresh_client.get("/api/local/map").json()["posts"]
    assert any(p["id"] == made["id"] and p["recruit_deadline"] == day(3) for p in on_map)
    one = fresh_client.get(f"/api/local/post/{made['id']}").json()
    assert one["recruit_deadline"] == day(3) and one["join_count"] == 0


def test_without_the_tag_the_sign_up_fields_are_empty(fresh_client, people):
    host = people("notag-extras@example.test", "主催")
    made = host.post(CAMPING_A, tags=[], recruit_deadline=day(3), recruit_capacity=4)
    assert made["recruit_deadline"] is None and made["recruit_capacity"] is None
    assert made["prompt"] is None


def test_bad_values_get_a_clear_422(fresh_client, people):
    host = people("bad-extras@example.test", "主催")

    def attempt(**fields):
        payload = {"body": CAMPING_A, "tags": [RECRUIT], **fields}
        return fresh_client.post("/api/posts", json=payload, headers=host.headers)

    for fields in ({"recruit_deadline": day(-1)}, {"recruit_deadline": day(400)},
                   {"recruit_deadline": "あした"}, {"recruit_capacity": 0},
                   {"recruit_capacity": 1000}, {"prompt": "someday"}):
        response = attempt(**fields)
        assert response.status_code == 422, fields
        assert response.json()["detail"]


def test_editing_the_extras(fresh_client, people):
    host = people("edit-extras@example.test", "主催")
    made = host.post(CAMPING_A, tags=[RECRUIT], recruit_deadline=day(2), recruit_capacity=3)
    url = f"/api/posts/{made['id']}"

    changed = fresh_client.patch(url, json={"recruit_capacity": 10, "prompt": "past"},
                                 headers=host.headers)
    assert changed.status_code == 200, changed.text
    assert changed.json()["recruit_capacity"] == 10
    assert changed.json()["recruit_deadline"] == day(2), "absent means leave it"
    assert changed.json()["prompt"] == "past"

    cleared = fresh_client.patch(url, json={"recruit_deadline": None, "prompt": None},
                                 headers=host.headers)
    assert cleared.json()["recruit_deadline"] is None and cleared.json()["prompt"] is None
    assert cleared.json()["recruit_capacity"] == 10

    assert fresh_client.patch(url, json={"recruit_deadline": day(-1)},
                              headers=host.headers).status_code == 422
    other = people("other-extras@example.test", "ほか")
    assert fresh_client.patch(url, json={"recruit_capacity": 2},
                              headers=other.headers).status_code == 403

    dropped = fresh_client.patch(url, json={"tags": []}, headers=host.headers)
    assert dropped.json()["recruit_capacity"] is None and dropped.json()["recruit_deadline"] is None


def test_an_expired_deadline_can_stay_when_other_things_change(fresh_client, people):
    host = people("expired-extras@example.test", "主催")
    made = host.post(CAMPING_A, tags=[RECRUIT], recruit_deadline=day(1), recruit_capacity=3)
    application.state["store"]._posts[made["id"]]["recruit_deadline"] = day(-4)  # time passed
    response = fresh_client.patch(f"/api/posts/{made['id']}",
                                  json={"recruit_deadline": day(-4), "recruit_capacity": 5},
                                  headers=host.headers)
    assert response.status_code == 200, response.text
    assert response.json()["recruit_closed"] == "deadline"


# --------------------------------------------------------------------------
# 受付終了
# --------------------------------------------------------------------------

def test_a_full_post_takes_no_new_join_but_old_ones_can_leave(fresh_client, people):
    host = people("full-host@example.test", "主催")
    one, two, three = (people(f"guest{i}-extras@example.test", f"客{i}") for i in range(3))
    made = host.post(CAMPING_A, tags=[RECRUIT], recruit_capacity=2)
    assert one.react(made["id"], "join").status_code == 200
    assert two.react(made["id"], "join").status_code == 200
    refused = three.react(made["id"], "join")
    assert refused.status_code == 409 and refused.json()["detail"] == "recruit_full"
    assert three.react(made["id"], "like").status_code == 200
    again = one.react(made["id"], "join")
    assert again.status_code == 200 and again.json()["created"] is False
    shown = fresh_client.get(f"/api/local/post/{made['id']}").json()
    assert shown["join_count"] == 2 and shown["recruit_closed"] == "full"
    assert one.unreact(made["id"], "join").status_code == 200
    assert three.react(made["id"], "join").status_code == 200


def test_a_post_past_its_deadline_takes_no_new_join(fresh_client, people):
    host = people("late-host@example.test", "主催")
    guest = people("late-guest@example.test", "客")
    made = host.post(CAMPING_A, tags=[RECRUIT], recruit_deadline=day(0))
    application.state["store"]._posts[made["id"]]["recruit_deadline"] = day(-1)
    refused = guest.react(made["id"], "join")
    assert refused.status_code == 409 and refused.json()["detail"] == "recruit_closed"
    assert fresh_client.get(f"/api/local/post/{made['id']}").json()["recruit_closed"] == "deadline"


def test_a_post_without_limits_takes_joins_as_before(fresh_client, people):
    host = people("free-host@example.test", "主催")
    guest = people("free-guest@example.test", "客")
    made = host.post(CAMPING_A, tags=[RECRUIT])
    assert guest.react(made["id"], "join").status_code == 200


# --------------------------------------------------------------------------
# a database the SQL has not reached: the features stay off, nothing breaks
# --------------------------------------------------------------------------

class FakeResponse:
    def __init__(self, status, payload):
        self.status_code = status
        self._payload = payload
        self.text = str(payload)
        self.content = b"x"
        self.headers = {}

    def json(self):
        return self._payload


def old_database(sent):
    """A SupabaseStore whose posts table has no 2026-10-20 columns."""
    store = SupabaseStore("http://127.0.0.1:1", "test-key")
    rows = {}

    def send(method, path, *, label, headers=None, params=None, json=None, allow_statuses=()):
        select = (params or {}).get("select", "")
        if method == "GET" and any(name in select for name in post_extras.EXTRA_COLUMNS):
            return FakeResponse(400, {"code": "42703",
                                      "message": "column posts.prompt does not exist"})
        sent.append((method, path, select, json))
        if method == "POST":
            rows["row"] = {**json, "id": "p1", "join_count": 0}
            return FakeResponse(201, [rows["row"]])
        if method == "PATCH":
            return FakeResponse(200, [{**rows["row"], **json}])
        return FakeResponse(200, [rows.get("row")] if rows else [])

    store._send = send
    return store


def test_an_old_database_turns_the_features_off_and_never_gets_the_columns():
    sent = []
    store = old_database(sent)
    assert store.supports_post_extras is False
    assert store.post_extras_ready() is False
    saved = store.insert_post({"id": "p1", "body": "x", "prompt": "now",
                               "recruit_deadline": "2030-01-01", "recruit_capacity": 3})
    assert "prompt" not in sent[-1][3] and "recruit_capacity" not in sent[-1][3]
    assert "prompt" not in sent[-1][2]
    assert saved["prompt"] is None and saved["recruit_closed"] is None
    assert store.update_post("p1", "a", {"prompt": "past"}) is None


def test_the_app_ignores_the_new_fields_while_the_database_is_old(fresh_client, people):
    host = people("old-db-extras@example.test", "主催")
    made = host.post(CAMPING_A, tags=[RECRUIT])
    store = application.state["store"]
    store.supports_post_extras = False
    try:
        config = fresh_client.get("/api/config").json()
        assert config["features"]["post_extras"] is False
        accepted = host.post("ふつうの投稿です", tags=[RECRUIT], prompt="bogus",
                             recruit_deadline="あした", recruit_capacity=0)
        assert accepted["id"]
        assert "recruit_deadline" not in store._posts[accepted["id"]] \
            or store._posts[accepted["id"]]["recruit_deadline"] is None
        edited = fresh_client.patch(f"/api/posts/{made['id']}", json={"recruit_capacity": 5},
                                    headers=host.headers)
        assert edited.status_code == 200, edited.text
        assert edited.json()["recruit_capacity"] is None
    finally:
        del store.supports_post_extras


def test_health_stays_ready_without_the_columns(fresh_client):
    store = application.state["store"]
    store.post_extras_ready = lambda: False
    try:
        data = fresh_client.get("/api/health").json()
    finally:
        del store.post_extras_ready
    assert data["post_extras_ready"] is False
    assert "post_extras" not in " ".join(data["not_ready_reasons"])
    assert data["ready"] is True


def test_failed_extras_check_is_not_retried_at_once():
    from core import store as store_module

    calls = []

    class Fake(store_module.SupabaseStore):
        def __init__(self):
            self._has_post_extras = False
            self._extras_checked_at = None

        def _send(self, *args, **kwargs):
            calls.append(1)
            raise store_module.StoreError("down")

    fake = Fake()
    assert fake.supports_post_extras is False
    assert fake.supports_post_extras is False
    assert len(calls) == 1
