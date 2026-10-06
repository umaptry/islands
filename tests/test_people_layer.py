"""The people layer: profiles, lines between people, islands that remember,
and the five kinds of notification.

One test (or a small group) per completion condition of stage 1 of the islands
redesign (2026-10-06), run against the local-mode app and MemoryStore, then the
pure functions underneath with hand-made inputs. Every person and post here is
made up for the test; none of the numbers are measurements of real use.
"""

from datetime import datetime, timedelta, timezone

import pytest

from conftest import BOOKKEEPING, CAMPING_A, SOLDERING, Person

NOW = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)


def at(days=0, minutes=0):
    return (NOW - timedelta(days=days, minutes=minutes)).isoformat()


@pytest.fixture
def app_module(fresh_client, monkeypatch):
    """The app with lines counted from any date and no cached lines."""
    import app as application

    # CONNECTIONS_SINCE is the public-lines launch date; the tests run on
    # whatever day the clock says, so they draw lines from any interaction.
    monkeypatch.setattr(application, "CONNECTIONS_SINCE", "2000-01-01T00:00:00+00:00")
    application.invalidate_connections()
    yield application
    application.invalidate_connections()


def put_profile(client, person, **fields):
    response = client.put("/api/account/me", json={"display_name": person.account["display_name"], **fields},
                          headers=person.headers)
    assert response.status_code == 200, response.text
    return response.json()["account"]


def lines_now(client, person=""):
    response = client.get("/api/connections", params={"person": person} if person else {})
    assert response.status_code == 200, response.text
    return response.json()["connections"]


# --------------------------------------------------------------------------
# 1. four profile fields, and people with close topics or goals rank first
# --------------------------------------------------------------------------

CAMPER = {"topics": ["キャンプ", "焚き火", "登山"],
          "goal": "冬までにソロキャンプで一晩過ごせるようになる"}


def test_people_with_close_topics_and_goals_rank_first(people, app_module):
    me = people("me@example.com", "わたし")
    near = people("near@example.com", "ちかい")
    books = people("books@example.com", "ぼき")
    solder = people("solder@example.com", "はんだ")
    c = me.client
    put_profile(c, me, **CAMPER)
    put_profile(c, near, topics=["キャンプ", "アウトドア", "焚き火"],
                goal="テント泊に慣れて山で一晩過ごしたい")
    put_profile(c, books, topics=["簿記", "会計", "資格"], goal="来年の春に簿記二級に合格する")
    put_profile(c, solder, topics=["電子工作", "半田付け"], goal="自作のキーボードを完成させる")

    response = c.get("/api/similar-people", headers=me.headers)
    assert response.status_code == 200, response.text
    ranked = response.json()["people"]
    assert ranked[0]["id"] == near.id, ranked
    assert ranked[0]["display_name"] == "ちかい"
    assert set(ranked[0]["shared_topics"]) == {"キャンプ", "焚き火"}
    assert all(row["id"] != me.id for row in ranked), "you are not similar to yourself"
    scores = [row["score"] for row in ranked]
    assert scores == sorted(scores, reverse=True)
    # Asking about somebody else works without signing in.
    other = c.get("/api/similar-people", params={"account": near.id}).json()["people"]
    assert other[0]["id"] == me.id


def test_the_weights_live_in_config(people, app_module, monkeypatch):
    """Same people, different weights, different order: nothing is hard-coded."""
    from core import affinity

    me = people("me@example.com", "わたし")
    same_topics = people("t@example.com", "話題が同じ")
    same_goal = people("g@example.com", "目標が同じ")
    c = me.client
    put_profile(c, me, **CAMPER)
    put_profile(c, same_topics, topics=CAMPER["topics"], goal="来年の春に簿記二級に合格する")
    put_profile(c, same_goal, topics=["簿記", "会計", "資格"], goal=CAMPER["goal"])

    def top():
        return c.get("/api/similar-people", headers=me.headers).json()["people"][0]["id"]

    monkeypatch.setattr(affinity, "AFFINITY_WEIGHTS",
                        {"topics": 1.0, "goal": 0.0, "seeking_offering": 0.0, "posts": 0.0})
    assert top() == same_topics.id
    monkeypatch.setattr(affinity, "AFFINITY_WEIGHTS",
                        {"topics": 0.0, "goal": 1.0, "seeking_offering": 0.0, "posts": 0.0})
    assert top() == same_goal.id


def test_profile_fields_are_cleaned_and_the_vectors_never_leave_the_server(people, app_module):
    me = people("me@example.com", "わたし")
    c = me.client
    long_word = "とても長い話題の言葉をここに書きます"
    account = put_profile(
        c, me,
        topics=["Ｃａｍｐ", "camp", long_word] + [f"話題{i}" for i in range(10)],
        goal="  山で\n一晩  過ごす  ",
        seeking="x" * 200,
        offering="",
    )
    assert account["topics"][0] == "Ｃａｍｐ"
    assert "camp" not in account["topics"], "the same word in another width is one topic"
    assert account["topics"][1] == long_word[:12]
    assert len(account["topics"]) == 8
    assert account["goal"] == "山で 一晩 過ごす"
    assert len(account["seeking"]) == 60
    assert account["offering"] is None
    for payload in (account,
                    c.get("/api/account/me", headers=me.headers).json()["account"],
                    c.get(f"/api/local/account/{me.id}").json()):
        assert not any(key.startswith("vec_") for key in payload), payload.keys()
    # ...but they were computed and stored.
    stored = {row["id"]: row for row in app_module.state["store"].profile_vectors()}[me.id]
    assert stored["vec_topics"] is not None and stored["vec_goal"] is not None
    assert stored["vec_offering"] is None


def test_an_embedding_outage_still_saves_the_words(people, app_module, monkeypatch):
    me = people("me@example.com", "わたし")

    def broken(model, fields):
        raise RuntimeError("embedding service down")

    monkeypatch.setattr(app_module.people, "embed_profile", broken)
    account = put_profile(me.client, me, topics=["キャンプ"], goal="山で一晩過ごす")
    assert account["topics"] == ["キャンプ"]
    stored = {row["id"]: row for row in app_module.state["store"].profile_vectors()}[me.id]
    assert stored["vec_topics"] is None and stored["vec_goal"] is None


def test_a_close_newcomer_is_announced_once_and_at_most_three_a_day(people, app_module):
    first = people("first@example.com", "さいしょ")
    c = first.client
    put_profile(c, first, **CAMPER)
    copies = [people(f"copy{i}@example.com", f"そっくり{i}") for i in range(4)]
    for copy in copies:
        put_profile(c, copy, **CAMPER)

    told = first.inbox({"similar"})
    assert len(told) == 3, "SIMILAR_NOTIFY_PER_DAY caps what one person hears in a day"
    assert told[0]["payload"]["shared_topics"] == CAMPER["topics"]
    assert told[0]["payload"]["score"] >= 0.75

    # Saving the same profile again tells nobody anything new.
    before = len(copies[0].inbox({"similar"}))
    put_profile(c, copies[1], **CAMPER)
    assert len(copies[0].inbox({"similar"})) == before
    # The person who saved is not told about themselves.
    assert all(row["actor_id"] != first.id for row in first.inbox({"similar"}))


# --------------------------------------------------------------------------
# 2. any interaction draws a line anyone can see; undoing it removes it
# --------------------------------------------------------------------------

@pytest.mark.parametrize("kind", ["like", "help", "join"])
def test_a_reaction_draws_a_line_and_taking_it_back_removes_it(people, app_module, kind):
    akari = people("a@example.com", "あかり")
    bannai = people("b@example.com", "ばんない")
    post = akari.post(CAMPING_A)
    c = akari.client
    assert lines_now(c) == []

    bannai.react(post["id"], kind)
    rows = lines_now(c)  # no Authorization header: a third party's view
    assert len(rows) == 1
    assert {rows[0]["a"], rows[0]["b"]} == {akari.id, bannai.id}
    assert post["id"] in (rows[0]["a_post"], rows[0]["b_post"])

    bannai.unreact(post["id"], kind)
    assert lines_now(c) == []


def test_a_line_carries_where_both_ends_stand_and_who_they_are(people, app_module):
    """The map draws a line, and the tap on its boat, from the row alone (stage 3)."""
    akari = people("a@example.com", "あかり")
    bannai = people("b@example.com", "ばんない")
    post = akari.post(CAMPING_A)
    own = bannai.post(SOLDERING)
    bannai.react(post["id"], "like")
    bannai.comment(post["id"], "いいですね")

    [row] = lines_now(akari.client)
    side = {row["a"]: "a", row["b"]: "b"}
    a, b = side[akari.id], side[bannai.id]
    assert row[f"{a}_post"] == post["id"]
    assert row[f"{b}_post"] == own["id"], "bannai's line end is their own post"
    assert row[f"{a}_at"] == [pytest.approx(post["x"]), pytest.approx(post["y"])]
    assert row[f"{b}_at"] == [pytest.approx(own["x"]), pytest.approx(own["y"])]
    assert (row[f"{a}_name"], row[f"{b}_name"]) == ("あかり", "ばんない")
    assert row["week"] == 2


def test_a_similar_person_comes_with_the_post_the_dotted_line_goes_to(people, app_module):
    me = people("me@example.com", "わたし")
    near = people("near@example.com", "ちかい")
    put_profile(me.client, me, **CAMPER)
    put_profile(me.client, near, topics=["キャンプ", "アウトドア", "焚き火"],
                goal="テント泊に慣れて山で一晩過ごしたい")
    own = near.post(CAMPING_A)

    [first] = me.client.get("/api/similar-people", headers=me.headers).json()["people"]
    assert first["id"] == near.id
    assert first["post"]["id"] == own["id"]
    assert (first["post"]["x"], first["post"]["y"]) == (pytest.approx(own["x"]), pytest.approx(own["y"]))


def test_a_comment_draws_a_line_and_deleting_it_removes_it(people, app_module):
    akari = people("a@example.com", "あかり")
    bannai = people("b@example.com", "ばんない")
    post = akari.post(CAMPING_A)
    c = akari.client

    comment = bannai.comment(post["id"], "いいですね").json()
    assert len(lines_now(c)) == 1
    deleted = c.request("DELETE", f"/api/local/comments/{comment['id']}", headers=bannai.headers)
    assert deleted.status_code == 200, deleted.text
    assert lines_now(c) == []


def test_a_reply_joins_the_replier_to_the_parent_and_the_author(people, app_module):
    akari = people("a@example.com", "あかり")
    bannai = people("b@example.com", "ばんない")
    chiaki = people("c@example.com", "ちあき")
    post = akari.post(CAMPING_A)
    c = akari.client

    parent = bannai.comment(post["id"], "どこでキャンプしましたか").json()
    reply = c.post("/api/local/comments", headers=chiaki.headers,
                   json={"post_id": post["id"], "body": "私も気になります", "reply_to": parent["id"]})
    assert reply.status_code == 200, reply.text
    assert reply.json()["reply_to"] == parent["id"]

    pairs = {frozenset((row["a"], row["b"])): row for row in lines_now(c)}
    assert set(pairs) == {frozenset((akari.id, bannai.id)), frozenset((chiaki.id, bannai.id)),
                          frozenset((chiaki.id, akari.id))}
    assert pairs[frozenset((chiaki.id, bannai.id))]["points"] == 3, "a reply is worth 3"
    assert pairs[frozenset((chiaki.id, akari.id))]["points"] == 2, "...and a comment to the author 2"
    # The person replied to hears about it as a 'reply'.
    assert [row["type"] for row in bannai.inbox({"reply"})] == ["reply"]


def test_a_reply_to_a_message_on_another_post_is_refused(people, app_module):
    akari = people("a@example.com", "あかり")
    bannai = people("b@example.com", "ばんない")
    one = akari.post(CAMPING_A)
    two = akari.post(BOOKKEEPING)
    parent = bannai.comment(one["id"], "いいですね").json()
    response = akari.client.post("/api/local/comments", headers=akari.headers,
                                 json={"post_id": two["id"], "body": "返信", "reply_to": parent["id"]})
    assert response.status_code == 422


def test_your_own_post_draws_no_line(people, app_module):
    akari = people("a@example.com", "あかり")
    post = akari.post(CAMPING_A)
    akari.react(post["id"], "like")
    akari.comment(post["id"], "補足です")
    assert lines_now(akari.client) == []


# --------------------------------------------------------------------------
# 4. one line per pair of people
# --------------------------------------------------------------------------

def test_one_line_per_pair_however_many_posts_and_taps(people, app_module):
    akari = people("a@example.com", "あかり")
    bannai = people("b@example.com", "ばんない")
    chiaki = people("c@example.com", "ちあき")
    posts = [akari.post(f"{CAMPING_A} その{i}") for i in range(10)]
    for post in posts:
        bannai.react(post["id"], "like")
        bannai.react(post["id"], "help")
    bannai.comment(posts[3]["id"], "これも良いですね")
    akari.comment(posts[3]["id"], "ありがとう")  # the author answering is not a new line

    c = akari.client
    rows = lines_now(c)
    assert len(rows) == 1, "ten posts and twenty-one interactions are still one pair"
    assert rows[0]["count"] == 21
    ends = {rows[0]["a"]: rows[0]["a_post"], rows[0]["b"]: rows[0]["b_post"]}
    assert ends[akari.id] == posts[3]["id"], "the line ends on the most-touched post"

    chiaki.react(posts[0]["id"], "like")
    assert len(lines_now(c)) == 2
    assert len(lines_now(c, person=chiaki.id)) == 1


def test_the_first_exchange_tells_both_people_once(people, app_module):
    akari = people("a@example.com", "あかり")
    bannai = people("b@example.com", "ばんない")
    post = akari.post(CAMPING_A)
    bannai.react(post["id"], "like")
    bannai.react(post["id"], "join")
    bannai.comment(post["id"], "いいですね")
    assert len(akari.inbox({"connection"})) == 1
    assert len(bannai.inbox({"connection"})) == 1


# --------------------------------------------------------------------------
# 15. island growth points (through the app)
# --------------------------------------------------------------------------

def test_people_posts_and_interactions_raise_an_islands_points(people, app_module):
    akari = people("a@example.com", "あかり")
    post = akari.post(CAMPING_A)
    store = app_module.state["store"]

    app_module.track_islands()
    [state] = store.island_states()
    assert state["post_ids"] == [post["id"]]
    assert state["score_total"] == pytest.approx(1.0 + 0.6)  # one person, one post

    for i in range(3):
        people(f"fan{i}@example.com", f"fan{i}").react(post["id"], "like")
    app_module.track_islands()
    [state] = store.island_states()
    assert state["score_total"] == pytest.approx(1.6 + 3 * 0.8)

    islands = akari.client.get("/api/islands").json()["islands"]
    assert islands[0]["island_id"] == state["id"]
    assert islands[0]["tier_name"] == "小屋"
    assert islands[0]["score"] == pytest.approx(state["score_shown"])
    assert len(islands[0]["landmarks"]) == 1, "an island is born with one landmark"


# --------------------------------------------------------------------------
# 17. islands that remember: merge, split and rename in the change list
# --------------------------------------------------------------------------

def fake_island(name, post_ids, cx):
    return {"name": name, "label": f"{name}島", "cx": cx, "cy": 0.5, "size": len(post_ids),
            "energy": 0, "cluster_id": 0, "post_ids": list(post_ids)}


def test_merges_splits_and_renames_are_listed_with_place_cause_and_counts(people, app_module, monkeypatch):
    akari = people("a@example.com", "あかり")
    ids = [akari.post(f"{text} その{i}")["id"]
           for i, text in enumerate([CAMPING_A] * 3 + [BOOKKEEPING] * 3)]
    steps = iter([
        [fake_island("山 / 焚き火", ids[:3], 0.2), fake_island("簿記", ids[3:], 0.8)],
        [fake_island("山 / 焚き火", ids, 0.5)],
        [fake_island("山歩き", ids[:3], 0.2), fake_island("簿記", ids[3:], 0.8)],
    ])
    monkeypatch.setattr(app_module, "live_islands", lambda force=False: next(steps))

    first = app_module.track_islands()
    assert {e["kind"] for e in first["events"]} >= {"birth"}
    assert first["notifications"] == [], "islands that were already there are not news"
    app_module.track_islands()
    app_module.track_islands()

    c = akari.client
    rows = c.get("/api/changes").json()["changes"]
    kinds = [row["kind"] for row in rows]
    for kind in ("birth", "merge", "split", "rename"):
        assert kind in kinds, kinds
    for row in rows:
        assert row["cause"], row
        assert set(row["place"]) == {"cx", "cy"}
        assert "before" in row and "after" in row

    merge = next(row for row in rows if row["kind"] == "merge")
    assert [island["posts"] for island in merge["before"]["islands"]] == [3, 3]
    assert merge["after"]["posts"] == 6
    split = next(row for row in rows if row["kind"] == "split")
    assert split["before"]["posts"] == 6
    assert sorted(island["posts"] for island in split["after"]["islands"]) == [3, 3]
    rename = next(row for row in rows if row["kind"] == "rename")
    assert (rename["before"]["name"], rename["after"]["name"]) == ("山 / 焚き火", "山歩き")
    assert merge["island_id"] == split["island_id"] == rename["island_id"], \
        "the island keeps one id through all three"

    # One island, three changes in a day: one notification.
    told = akari.inbox({"island"})
    assert len(told) == 1
    assert told[0]["payload"]["kind"] == "merge"

    assert c.get("/api/changes", params={"since": "昨日"}).status_code == 422
    assert c.get("/api/changes", params={"limit": 1}).json()["changes"] == rows[:1]


def test_the_away_digest_puts_your_islands_first_and_starts_again_from_now(people, app_module, monkeypatch):
    akari = people("a@example.com", "あかり")
    stranger = people("s@example.com", "とおりすがり")
    ids = [akari.post(f"{CAMPING_A} その{i}")["id"] for i in range(2)]
    steps = iter([
        [fake_island("山", ids[:1], 0.2), fake_island("火", ids[1:], 0.8)],
        [fake_island("山 / 火", ids, 0.5)],
    ])
    monkeypatch.setattr(app_module, "live_islands", lambda force=False: next(steps))
    app_module.track_islands()
    app_module.track_islands()
    c = akari.client

    mine = c.get("/api/changes/digest", headers=akari.headers).json()
    assert mine["since"] is None, "a first visit looks back a fixed window"
    assert 0 < len(mine["changes"]) <= 5
    assert mine["changes"][0]["reason"] == "mine"
    again = c.get("/api/changes/digest", headers=akari.headers).json()
    assert again["since"] is not None and again["changes"] == []

    theirs = c.get("/api/changes/digest", headers=stranger.headers).json()["changes"]
    assert theirs and all(row["reason"] == "big" for row in theirs)
    assert all(row["kind"] in ("merge", "split", "birth", "tier") for row in theirs)
    assert c.get("/api/changes/digest").status_code == 401


# --------------------------------------------------------------------------
# 22. five kinds of notification, each with a push and an in-app switch
# --------------------------------------------------------------------------

def test_every_kind_has_a_push_and_an_in_app_switch(people, app_module):
    akari = people("a@example.com", "あかり")
    c = akari.client
    settings = c.get("/api/notification-settings", headers=akari.headers).json()
    assert settings["categories"] == ["reply", "reaction", "connection", "similar", "island"]
    assert all(value == {"push": True, "in_app": True} for value in settings["settings"].values())

    saved = c.put("/api/notification-settings", headers=akari.headers, json={"settings": [
        {"category": "reaction", "push": False, "in_app": False},
        {"category": "island", "push": False, "in_app": True},
    ]}).json()["settings"]
    assert saved["reaction"] == {"push": False, "in_app": False}
    assert saved["island"] == {"push": False, "in_app": True}
    assert saved["reply"] == {"push": True, "in_app": True}

    bad = c.put("/api/notification-settings", headers=akari.headers,
                json={"settings": [{"category": "marketing", "push": True, "in_app": True}]})
    assert bad.status_code == 422
    assert c.get("/api/notification-settings").status_code == 401


def test_reactions_are_grouped_and_a_switched_off_kind_stays_listed_without_a_badge(people, app_module):
    akari = people("a@example.com", "あかり")
    fans = [people(f"f{i}@example.com", f"ファン{i}") for i in range(3)]
    post = akari.post(CAMPING_A)
    for fan in fans:
        fan.react(post["id"], "like")
    c = akari.client

    feed = c.get("/api/local/notifications/feed", headers=akari.headers).json()
    reactions = [row for row in feed["notifications"] if row["category"] == "reaction"]
    assert len(reactions) == 1, "three likes within ten minutes are one entry"
    assert reactions[0]["others"] == 2
    assert reactions[0]["actors"][0]["display_name"] == "ファン2", "newest first"
    assert len(reactions[0]["ids"]) == 3
    assert feed["unread"] == 1 + 3, "the grouped likes and three new connections"

    c.put("/api/notification-settings", headers=akari.headers,
          json={"settings": [{"category": "reaction", "push": True, "in_app": False}]})
    feed = c.get("/api/local/notifications/feed", headers=akari.headers).json()
    reactions = [row for row in feed["notifications"] if row["category"] == "reaction"]
    assert reactions and reactions[0]["interrupts"] is False, "still listed"
    assert feed["unread"] == 3, "but no longer counted on the badge"


# --------------------------------------------------------------------------
# the pure functions underneath
# --------------------------------------------------------------------------

def event(actor, owner, post, kind="like", days=0, reply_author=None):
    return {"actor_id": actor, "post_author_id": owner, "post_id": post, "kind": kind,
            "reply_author_id": reply_author, "created_at": at(days)}


def test_connections_points_decay_tiers_and_faint_lines():
    from core import connections

    events = [event("b", "a", "p1", "like", days=0), event("b", "a", "p1", "comment", days=1)]
    [line] = connections.build(events, now=NOW)
    assert (line["a"], line["b"]) == ("a", "b")
    assert line["points"] == 3 and line["count"] == 2
    assert line["strength"] == pytest.approx(1 + 2 * 0.5 ** (1 / 14), abs=1e-3)
    assert line["tier"] == 1, "2.95 after a day of decay is still under the first bound"
    assert line["ongoing"] and not line["faint"]
    two = [event("b", "a", "p1", "comment"), event("b", "a", "p1", "comment")]
    assert connections.build(two, now=NOW)[0]["tier"] == 2

    [old] = connections.build([event("b", "a", "p1", days=40)], now=NOW)
    assert old["faint"] and old["tier"] == 1 and not old["ongoing"]
    assert connections.build([event("a", "a", "p1")], now=NOW) == []
    many = [event("b", "a", f"p{i}", "comment") for i in range(5)]
    assert connections.build(many, now=NOW)[0]["tier"] == 3

    week = [event("b", "a", "p1", days=d) for d in (0, 3, 6.9, 8, 20)]
    assert connections.build(week, now=NOW)[0]["week"] == 3, "only the last seven days count"


def test_a_reply_to_your_own_comment_thread_counts_once():
    from core import connections

    # The author replying to a comment on their own post: one pair, reply points.
    pairs = connections.expand(event("a", "a", "p1", "reply", reply_author="b"))
    assert pairs == [("a", "b", 3, "p1", "a")]
    # Replying to yourself is nobody.
    assert connections.expand(event("b", "a", "p1", "reply", reply_author="b")) == [("b", "a", 2, "p1", "a")]


def test_the_fallback_post_ends_a_line_on_a_person_whose_posts_were_not_touched():
    from core import connections

    [line] = connections.build([event("b", "a", "p1")], now=NOW, fallback_posts={"b": "pb"})
    assert (line["a_post"], line["b_post"]) == ("p1", "pb")
    assert connections.partners([line], "a") == {"b"}


def posts_by(author, count, days=0):
    return [{"id": f"{author}{i}", "author_id": author, "created_at": at(days)} for i in range(count)]


def test_mass_posting_only_counts_through_a_square_root():
    from core import growth

    alone = growth.score(posts_by("a", 16), [], now=NOW)
    crowd = growth.score([p for i in range(16) for p in posts_by(f"p{i}-", 1)], [], now=NOW)
    assert alone["parts"]["posts"] == pytest.approx(4.0)
    assert alone["total"] == pytest.approx(1 + 4 * 0.6)
    assert crowd["total"] == pytest.approx(16 + 16 * 0.6)


def test_interactions_count_once_per_post_and_day_and_five_a_day():
    from core import growth

    posts = posts_by("a", 8)
    taps = [event("b", "a", p["id"], kind) for p in posts for kind in ("like", "help")]
    result = growth.score(posts, taps, now=NOW)
    assert result["parts"]["interactions"] == 5, "GROWTH_DAILY_CAP per person per day"
    old = growth.score(posts_by("a", 1, days=30), [], now=NOW)
    assert old["recent"] == 0 and old["total"] > 0


def test_tiers_step_up_at_once_and_down_only_well_below():
    from core import growth

    assert growth.tier_name(growth.tier_for(0)) == "小屋"
    assert growth.tier_for(8) == 1 and growth.tier_for(20) == 2 and growth.tier_for(95) == 4
    assert growth.tier_for(7.0, previous=1) == 1, "within 20% of the bound keeps the tier"
    assert growth.tier_for(6.0, previous=1) == 0
    assert growth.shown(10.0, 2.0) == pytest.approx(8.0), "shrinks at most 20% per update"
    assert growth.shown(10.0, 12.0) == 12.0


def test_tracking_keeps_an_island_through_a_reclustering():
    from core import island_tracking

    posts = {f"p{i}": {"id": f"p{i}", "author_id": "a", "created_at": at()} for i in range(6)}
    one = island_tracking.update([], [fake_island("山", ["p0", "p1", "p2"], 0.1)], posts, [], now=NOW)
    [born] = one["events"]
    assert born["kind"] == "birth" and born["after"]["posts"] == 3

    # Two of three posts stay: same island. A different name is a rename.
    two = island_tracking.update(one["states"], [fake_island("川", ["p1", "p2", "p3"], 0.1)],
                                 posts, [], now=NOW)
    assert two["states"][0]["id"] == one["states"][0]["id"]
    assert [e["kind"] for e in two["events"]] == ["rename"]

    # Every post gone: the island goes quiet and is closed.
    three = island_tracking.update(two["states"], [fake_island("海", ["p4", "p5"], 0.9)],
                                   posts, [], now=NOW)
    quiet = next(e for e in three["events"] if e["kind"] == "quiet")
    assert quiet["island_id"] == one["states"][0]["id"]
    assert quiet["cause"] == island_tracking.CAUSES["quiet_gone"]
    assert not next(s for s in three["states"] if s["id"] == quiet["island_id"])["active"]


def test_a_landmark_is_swapped_only_after_a_challenger_leads_for_three_days():
    from core import island_tracking

    posts = {"p0": {"id": "p0", "author_id": "a", "created_at": at()}}
    island = [fake_island("山", ["p0"], 0.5)]
    first = island_tracking.update([], island, posts, [], now=NOW, rank_landmarks=lambda i: ["灯台", "風車"])
    assert first["states"][0]["landmarks"][0]["name"] == "灯台"

    states = first["states"]
    for day in range(4):
        result = island_tracking.update(states, island, posts, [], now=NOW + timedelta(days=day),
                                        rank_landmarks=lambda i: ["風車", "灯台"])
        states = result["states"]
        names = [item["name"] for item in states[0]["landmarks"]]
        assert names == (["灯台"] if day < 3 else ["風車"]), (day, names)
    assert result["events"][-1]["kind"] == "landmark"


def test_reactions_group_in_a_ten_minute_chain():
    from core import notifications

    def row(i, post, minutes, kind="like"):
        return {"id": f"n{i}", "type": kind, "post_id": post, "actor_id": f"u{i}",
                "created_at": at(minutes=minutes), "read_at": None}

    chained = notifications.group_feed([row(1, "p", 16), row(2, "p", 8), row(3, "p", 0)])
    assert len(chained) == 1 and chained[0]["others"] == 2
    apart = notifications.group_feed([row(1, "p", 11), row(2, "p", 0)])
    assert len(apart) == 2
    other_post = notifications.group_feed([row(1, "p", 1), row(2, "q", 0)])
    assert len(other_post) == 2
    comments = notifications.group_feed([row(1, "p", 1, "comment"), row(2, "p", 0, "comment")])
    assert len(comments) == 2, "only reactions are grouped"


def test_settings_default_to_on_and_map_types_to_categories():
    from core import notifications

    settings = notifications.merge_settings([{"category": "reaction", "push": False, "in_app": True}])
    assert notifications.allows(settings, "like", "in_app")
    assert not notifications.allows(settings, "join", "push")
    assert notifications.allows(settings, "reply", "push")
    assert notifications.category_of("comment") == "reply"


def test_affinity_drops_empty_parts_and_reweights_the_rest():
    from core import affinity

    a = {"id": "a", "topics": ["山"], "vec_topics": [1.0, 0.0], "vec_goal": [1.0, 0.0]}
    b = {"id": "b", "topics": ["山", "川"], "vec_topics": [1.0, 0.0], "vec_goal": None}
    result = affinity.affinity(a, b, profile_anchor=(0.0, 1.0))
    assert result["score"] == pytest.approx(1.0), "an empty goal neither helps nor hurts"
    assert result["parts"]["goal"] is None
    assert result["shared_topics"] == ["山"]
    assert affinity.affinity({"id": "x"}, b, profile_anchor=(0.0, 1.0)) is None

    # seeking meets offering in either direction; the better one counts.
    seeker = {"id": "s", "vec_seeking": [1.0, 0.0]}
    helper = {"id": "h", "vec_offering": [1.0, 0.0], "vec_seeking": [0.0, 1.0]}
    assert affinity.affinity(seeker, helper, profile_anchor=(0.0, 1.0))["parts"]["seeking_offering"] == 1.0


def test_profiles_are_embedded_in_one_call():
    from core import affinity

    calls = []

    class Model:
        def encode(self, texts, normalize_embeddings=True):
            calls.append(list(texts))
            return [[1.0, 0.0]] * len(texts)

    vectors = affinity.embed_profile(Model(), {"topics": ["山", "川"], "goal": "登る", "seeking": " "})
    assert calls == [["山、川", "登る"]]
    assert vectors["vec_topics"] == [1.0, 0.0] and vectors["vec_seeking"] is None
