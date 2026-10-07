"""Stage 5 of the islands redesign: the small moments around posting.

A prompt for the week (Q37), a first post tried out with an example sentence
that is never saved (Q40), "talk to me" on a post (Q45) and footprints that
are a number only the author sees (Q35, Q46). Everybody here is made up.
"""

from datetime import datetime, timedelta, timezone

import app as application

from conftest import BOOKKEEPING, CAMPING_A, CAMPING_B
from core.config import EXAMPLE_POSTS, TAGS, WEEKLY_PROMPTS
from core.prompts import weekly_prompt

ANON = "anon:0123456789abcdef0123456789abcdef"


# --------------------------------------------------------------------------
# the prompt of the week
# --------------------------------------------------------------------------

def test_the_week_turns_at_monday_midnight_in_japan():
    sunday_night = weekly_prompt(datetime(2026, 10, 11, 14, 59, tzinfo=timezone.utc))
    monday = weekly_prompt(datetime(2026, 10, 11, 15, 0, tzinfo=timezone.utc))
    assert sunday_night["key"] == "2026-W41"
    assert monday["key"] == "2026-W42"
    assert sunday_night["until"] == "2026-10-11T15:00:00+00:00"
    assert monday["text"] != sunday_night["text"]


def test_every_prompt_comes_round_before_any_repeats():
    start = datetime(2026, 10, 5, 0, 0, tzinfo=timezone.utc)
    seen = [weekly_prompt(start + timedelta(weeks=i))["text"] for i in range(len(WEEKLY_PROMPTS))]
    assert sorted(seen) == sorted(WEEKLY_PROMPTS)


def test_config_carries_the_prompt_the_examples_and_the_open_tag(client):
    data = client.get("/api/config").json()
    assert data["weekly_prompt"]["text"] in WEEKLY_PROMPTS
    assert data["example_posts"] == list(EXAMPLE_POSTS)
    assert data["open_tag"] == TAGS[0]
    assert all(len(text) <= data["limits"]["body_max"] for text in data["example_posts"])


# --------------------------------------------------------------------------
# the tryout: placed, never saved (Q40)
# --------------------------------------------------------------------------

def test_a_tryout_is_placed_but_nothing_is_saved(fresh_client, people):
    writer = people("writer5@example.test", "かく人")
    writer.post(CAMPING_A)
    newcomer = people("new5@example.test", "はじめて")
    before = application.state["store"].count_posts()
    response = fresh_client.post("/api/posts/preview", json={"body": CAMPING_B},
                                 headers=newcomer.headers)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["saved"] is False
    assert isinstance(data["x"], float) and isinstance(data["y"], float)
    assert data["neighbors"], "the one saved post is somebody to stand near"
    assert data["neighbors"][0]["display_name"] == "かく人"
    assert application.state["store"].count_posts() == before
    assert application.state["store"].posts_by_author(newcomer.id) == [],         "the example sentence is not the newcomer's post"


def test_a_tryout_needs_a_sign_in_and_a_body(fresh_client, people):
    assert fresh_client.post("/api/posts/preview", json={"body": CAMPING_B}).status_code == 401
    someone = people("body5@example.test", "だれか")
    response = fresh_client.post("/api/posts/preview", json={"body": "   "},
                                 headers=someone.headers)
    assert response.status_code == 422


# --------------------------------------------------------------------------
# footprints: a number, only for the author (Q35, Q46)
# --------------------------------------------------------------------------

def test_each_viewer_counts_once_and_the_author_never(fresh_client, people):
    author = people("author5@example.test", "書いた人")
    reader = people("reader5@example.test", "読んだ人")
    post = author.post(BOOKKEEPING)["id"]

    def view(headers=None, viewer=None):
        return fresh_client.post(f"/api/posts/{post}/view", json={"viewer": viewer},
                                 headers=headers or {})

    assert view(viewer=ANON).json() == {"counted": True}
    assert view(viewer=ANON.upper().replace("ANON", "anon")).json() == {"counted": True}
    assert view(headers=reader.headers).json() == {"counted": True}
    assert view(headers=reader.headers).json() == {"counted": True}
    assert view(headers=author.headers).json() == {"counted": False}
    counts = fresh_client.get("/api/me/views", headers=author.headers).json()["views"]
    assert counts == {post: 2}


def test_views_are_only_ever_your_own(fresh_client, people):
    author = people("own5@example.test", "自分")
    other = people("other5@example.test", "ほか")
    post = author.post(CAMPING_A)["id"]
    fresh_client.post(f"/api/posts/{post}/view", json={"viewer": ANON})
    assert fresh_client.get("/api/me/views", headers=other.headers).json()["views"] == {}
    assert fresh_client.get("/api/me/views").status_code == 401


def test_a_made_up_viewer_key_or_post_is_refused(fresh_client, people):
    author = people("bad5@example.test", "だれか")
    post = author.post(CAMPING_A)["id"]
    for key in (None, "", "anon:xyz", "someone-else", "anon:" + "0" * 65):
        response = fresh_client.post(f"/api/posts/{post}/view", json={"viewer": key})
        assert response.status_code == 422, key
    assert fresh_client.post("/api/posts/not-a-post/view",
                             json={"viewer": ANON}).status_code == 404
    gone = fresh_client.post("/api/posts/00000000-0000-4000-8000-000000000999/view",
                             json={"viewer": ANON})
    assert gone.json() == {"counted": False}
