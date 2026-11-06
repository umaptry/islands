"""/api/text-check (2026-11-07): the words checked while they are typed, so the reason shows under the box."""

import app as application
from tests.test_events import create_event, post, world  # noqa: F401  (world is a fixture)

EMPTY_OF_WORDS = "🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂"


def test_words_the_map_knows_are_fine(people, fresh_client):
    me = people("text-a@example.com", "あおい")
    response = fresh_client.post("/api/text-check", json={"body": "週末は山に登って写真を撮っています。"}, headers=me.headers)
    assert response.status_code == 200
    assert response.json() == {"ok": True, "message": None}


def test_words_it_does_not_know_say_why_as_posting_would(people, fresh_client):
    me = people("text-b@example.com", "いちか")
    said = fresh_client.post("/api/text-check", json={"body": EMPTY_OF_WORDS}, headers=me.headers).json()
    assert said == {"ok": False, "message": application.NO_MEANING}
    posted = fresh_client.post("/api/posts", json={"body": EMPTY_OF_WORDS, "motivation": 50}, headers=me.headers)
    assert posted.status_code == 422 and posted.json()["detail"] == application.NO_MEANING


def test_it_needs_a_signed_in_person(fresh_client):
    assert fresh_client.post("/api/text-check", json={"body": "山に登る"}).status_code == 401


def test_an_answer_the_server_refuses_names_its_question(world):
    admin, cid, people = world
    code = create_event(admin, cid, visibility="public")["event"]["public_code"]
    event = application.state["store"].event_by_code(code)
    guest = people("text-g@example.test", "ゲスト")
    first = event["questions"][0]
    r = post(guest, f"/api/events/{code}/apply", {
        "agree_terms": True, "profile": {"display_name": "山田 花子", "affiliation": "○○", "age": "30s"},
        "answers": [{"prompt": first["prompt"], "body": EMPTY_OF_WORDS},
                    {"prompt": event["questions"][1]["prompt"], "body": "週末は山に登って写真を撮っています。"}]})
    assert r.status_code == 422
    assert r.json()["detail"] == f"「{first['label']}」の答え：{application.NO_MEANING}"
