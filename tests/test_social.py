"""Reactions, comments, notifications, and who is allowed to do what.

islands had all of this in a Zustand store in one browser tab, which meant the
counts were whatever that tab believed and the notifications congratulated you
on your own taps. These are the properties that have to hold once there are two
people and two devices.
"""

from conftest import BOOKKEEPING, CAMPING_A, CAMPING_B


# --------------------------------------------------------------------------
# counters
# --------------------------------------------------------------------------

def test_a_reaction_raises_the_count_and_the_energy(people, fresh_client):
    akari = people("a@example.com", "あかり")
    bannai = people("b@example.com", "ばんない")
    post = akari.post(CAMPING_A, motivation=40)
    assert post["energy"] == 40

    bannai.react(post["id"], "like")
    fresh = fresh_client.get(f"/api/local/post/{post['id']}").json()
    assert fresh["like_count"] == 1
    # islands' formula, all the way through to the number the map draws with.
    assert fresh["energy"] == 45


def test_reacting_twice_is_the_same_as_reacting_once(people, fresh_client):
    akari = people("a@example.com", "あかり")
    bannai = people("b@example.com", "ばんない")
    post = akari.post(CAMPING_A)

    first = bannai.react(post["id"], "like").json()
    second = bannai.react(post["id"], "like").json()
    assert first["created"] is True
    assert second["created"] is False, "a repeat tap must not be a second like"

    fresh = fresh_client.get(f"/api/local/post/{post['id']}").json()
    assert fresh["like_count"] == 1


def test_the_three_reactions_are_counted_separately(people, fresh_client):
    akari = people("a@example.com", "あかり")
    bannai = people("b@example.com", "ばんない")
    post = akari.post(CAMPING_A, motivation=0)

    for kind in ("like", "help", "join"):
        bannai.react(post["id"], kind)
    fresh = fresh_client.get(f"/api/local/post/{post['id']}").json()
    assert (fresh["like_count"], fresh["help_count"], fresh["join_count"]) == (1, 1, 1)
    assert fresh["energy"] == 15


def test_taking_a_reaction_back_lowers_the_count(people, fresh_client):
    akari = people("a@example.com", "あかり")
    bannai = people("b@example.com", "ばんない")
    post = akari.post(CAMPING_A, motivation=20)

    bannai.react(post["id"], "help")
    bannai.unreact(post["id"], "help")
    fresh = fresh_client.get(f"/api/local/post/{post['id']}").json()
    assert fresh["help_count"] == 0
    assert fresh["energy"] == 20


def test_a_comment_raises_the_comment_count(people, fresh_client):
    akari = people("a@example.com", "あかり")
    bannai = people("b@example.com", "ばんない")
    post = akari.post(CAMPING_A, motivation=10)

    bannai.comment(post["id"], "どこの河原ですか？")
    fresh = fresh_client.get(f"/api/local/post/{post['id']}").json()
    assert fresh["comment_count"] == 1
    assert fresh["energy"] == 15, "a message is worth the same as a reaction"


# --------------------------------------------------------------------------
# notifications
# --------------------------------------------------------------------------

def test_the_author_is_told_and_the_actor_is_not(people):
    akari = people("a@example.com", "あかり")
    bannai = people("b@example.com", "ばんない")
    post = akari.post(CAMPING_A)

    bannai.react(post["id"], "like")
    bannai.comment(post["id"], "いいですね")

    inbox = akari.inbox()
    assert {row["type"] for row in inbox} == {"like", "comment"}
    assert all(row["actor"]["display_name"] == "ばんない" for row in inbox)
    assert bannai.inbox() == [], "the person who tapped does not get told about it"


def test_reacting_to_your_own_post_notifies_nobody(people):
    akari = people("a@example.com", "あかり")
    post = akari.post(CAMPING_A)
    akari.react(post["id"], "like")
    akari.comment(post["id"], "自分で補足します")
    assert akari.inbox() == [], (
        "islands notified you about your own taps; that is noise, not news"
    )


def test_undoing_an_unread_reaction_withdraws_the_notification(people):
    akari = people("a@example.com", "あかり")
    bannai = people("b@example.com", "ばんない")
    post = akari.post(CAMPING_A)

    bannai.react(post["id"], "join")
    assert len(akari.unread()) == 1
    bannai.unreact(post["id"], "join")
    assert akari.unread() == [], "an un-tapped reaction should not leave a ghost"


def test_a_notification_already_read_survives_the_undo(people, fresh_client):
    """Something somebody has already seen is a thing that happened."""
    akari = people("a@example.com", "あかり")
    bannai = people("b@example.com", "ばんない")
    post = akari.post(CAMPING_A)

    bannai.react(post["id"], "help")
    fresh_client.post(
        "/api/local/notifications/read", json={"ids": None}, headers=akari.headers
    )
    assert akari.unread() == []

    bannai.unreact(post["id"], "help")
    assert len(akari.inbox()) == 1, "a read notification is history, not state"


def test_marking_all_read_clears_the_badge(people, fresh_client):
    akari = people("a@example.com", "あかり")
    bannai = people("b@example.com", "ばんない")
    post = akari.post(CAMPING_A)
    for kind in ("like", "help", "join"):
        bannai.react(post["id"], kind)
    assert len(akari.unread()) == 3

    response = fresh_client.post(
        "/api/local/notifications/read", json={"ids": None}, headers=akari.headers
    )
    assert response.json()["updated"] == 3
    assert akari.unread() == []


def test_nobody_can_read_somebody_elses_inbox(people):
    akari = people("a@example.com", "あかり")
    bannai = people("b@example.com", "ばんない")
    post = akari.post(CAMPING_A)
    bannai.react(post["id"], "like")

    # There is no parameter to ask for another person's inbox: the route reads
    # the id out of the token. This is the test that says so.
    assert akari.inbox()
    assert bannai.inbox() == []


# --------------------------------------------------------------------------
# profile
# --------------------------------------------------------------------------

def test_a_profile_field_can_be_emptied_again(people, fresh_client):
    """Writing a 自己紹介 must not be a one-way door.

    The edit screen sends every field on every save, with an empty box as null.
    While the API dropped nulls, that save read as "no opinion about bio" and
    the old text stayed - so the only way to remove something you had written
    was to overwrite it with other text.
    """
    akari = people("a@example.com", "あかり")
    written = fresh_client.put(
        "/api/account/me",
        json={"display_name": "あかり", "bio": "消える自己紹介", "link_url": "example.com"},
        headers=akari.headers,
    ).json()["account"]
    assert written["bio"] == "消える自己紹介"

    cleared = fresh_client.put(
        "/api/account/me",
        json={"display_name": "あかり", "bio": None, "link_url": None},
        headers=akari.headers,
    ).json()["account"]
    assert cleared["bio"] is None
    assert cleared["link_url"] is None
    assert cleared["display_name"] == "あかり"


def test_whitespace_only_is_the_same_request_as_clearing(people, fresh_client):
    akari = people("a@example.com", "あかり")
    fresh_client.put(
        "/api/account/me", json={"display_name": "あかり", "bio": "なにか"},
        headers=akari.headers,
    )
    row = fresh_client.put(
        "/api/account/me", json={"display_name": "あかり", "bio": "   "},
        headers=akari.headers,
    ).json()["account"]
    assert row["bio"] is None


def test_a_field_left_out_is_left_alone(people, fresh_client):
    """The other half of the rule: absent means "leave it", not "erase it"."""
    akari = people("a@example.com", "あかり")
    fresh_client.put(
        "/api/account/me", json={"display_name": "あかり", "bio": "残る自己紹介"},
        headers=akari.headers,
    )
    row = fresh_client.put(
        "/api/account/me", json={"icon_id": "7"}, headers=akari.headers
    ).json()["account"]
    assert row["bio"] == "残る自己紹介"
    assert row["icon_id"] == "7"


def test_the_name_is_the_one_field_that_cannot_be_cleared(people, fresh_client):
    """It is what the map draws under a marker, and the column is not null."""
    akari = people("a@example.com", "あかり")
    for value in (None, "", "   "):
        response = fresh_client.put(
            "/api/account/me", json={"display_name": value}, headers=akari.headers
        )
        assert response.status_code == 422, value


def test_an_avatar_can_be_taken_off_again(people, fresh_client):
    """The emoji discs are the fallback, so avatar_path has to be clearable."""
    akari = people("a@example.com", "あかり")
    with_photo = fresh_client.put(
        "/api/account/me", json={"avatar_path": f"{akari.id}/portrait.webp"},
        headers=akari.headers,
    ).json()["account"]
    assert with_photo["avatar_path"] == f"{akari.id}/portrait.webp"

    back_to_emoji = fresh_client.put(
        "/api/account/me", json={"avatar_path": None}, headers=akari.headers
    ).json()["account"]
    assert back_to_emoji["avatar_path"] is None


# --------------------------------------------------------------------------
# authorisation
# --------------------------------------------------------------------------

def test_posting_needs_a_token(fresh_client):
    response = fresh_client.post("/api/posts", json={"body": CAMPING_A})
    assert response.status_code == 401


def test_a_forged_token_is_refused(fresh_client):
    response = fresh_client.post(
        "/api/posts", json={"body": CAMPING_A},
        headers={"Authorization": "Bearer not.a.token"},
    )
    assert response.status_code == 401


def test_posting_needs_a_profile_first(fresh_client):
    """A token without an account row cannot post: the map shows a name."""
    code = fresh_client.post(
        "/api/local/auth/otp", json={"email": "nobody@example.com"}
    ).json()["code"]
    token = fresh_client.post(
        "/api/local/auth/verify", json={"email": "nobody@example.com", "code": code}
    ).json()["access_token"]
    response = fresh_client.post(
        "/api/posts", json={"body": CAMPING_A},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 409


def test_only_the_author_can_edit(people, fresh_client):
    akari = people("a@example.com", "あかり")
    bannai = people("b@example.com", "ばんない")
    post = akari.post(CAMPING_A)

    response = fresh_client.patch(
        f"/api/posts/{post['id']}", json={"motivation": 99}, headers=bannai.headers
    )
    assert response.status_code == 403
    assert fresh_client.get(f"/api/local/post/{post['id']}").json()["motivation"] == 50


def test_only_the_author_can_delete(people, fresh_client):
    akari = people("a@example.com", "あかり")
    bannai = people("b@example.com", "ばんない")
    post = akari.post(CAMPING_A)

    assert fresh_client.delete(
        f"/api/posts/{post['id']}", headers=bannai.headers
    ).status_code == 403
    assert fresh_client.delete(
        f"/api/posts/{post['id']}", headers=akari.headers
    ).status_code == 200


def test_a_deleted_post_leaves_the_map_but_not_the_conversation(people, fresh_client):
    """Soft delete. The comments other people left are their words, not ours."""
    akari = people("a@example.com", "あかり")
    bannai = people("b@example.com", "ばんない")
    post = akari.post(CAMPING_A)
    bannai.comment(post["id"], "参加したいです")
    bannai.react(post["id"], "join")

    fresh_client.delete(f"/api/posts/{post['id']}", headers=akari.headers)

    assert fresh_client.get(f"/api/local/post/{post['id']}").status_code == 404
    ids = [row["id"] for row in fresh_client.get("/api/local/map").json()["posts"]]
    assert post["id"] not in ids
    # And nothing 500s on the way past.
    assert fresh_client.get("/api/islands").status_code == 200
    assert akari.inbox()


# --------------------------------------------------------------------------
# posting rules
# --------------------------------------------------------------------------

def test_a_post_shorter_than_the_floor_is_refused(people, fresh_client):
    akari = people("a@example.com", "あかり")
    response = fresh_client.post(
        "/api/posts", json={"body": "短い"}, headers=akari.headers
    )
    assert response.status_code == 422


def test_a_post_is_capped_at_islands_limit(people, fresh_client):
    """140 characters, from islands' requirements. Trimmed, not rejected."""
    akari = people("a@example.com", "あかり")
    long_text = "焚き火とコーヒーの話をします。" * 30
    post = akari.post(long_text)
    assert len(post["body"]) == 140


def test_only_the_four_tags_survive(people):
    akari = people("a@example.com", "あかり")
    post = akari.post(
        CAMPING_A, tags=["助けてほしい", "存在しないタグ", "気軽に話しかけて", "助けてほしい"],
    )
    # Canonical order, de-duplicated, invented ones dropped.
    assert post["tags"] == ["気軽に話しかけて", "助けてほしい"]


def test_motivation_is_clamped(people):
    akari = people("a@example.com", "あかり")
    assert akari.post(CAMPING_A, motivation=500)["motivation"] == 100
    assert akari.post(CAMPING_B, motivation=-20)["motivation"] == 0


def test_contact_details_are_stripped_from_a_post(people):
    akari = people("a@example.com", "あかり")
    post = akari.post(
        "連絡先は me@example.com です。詳しくは https://example.com/blog を見てください。焚き火が好きです。"
    )
    assert "me@example.com" not in post["body"]
    assert "https://example.com" not in post["body"]
    assert "[メール]" in post["body"] and "[リンク]" in post["body"]


# --------------------------------------------------------------------------
# the local shim exists only when there is no Supabase
# --------------------------------------------------------------------------

def test_the_local_routes_disappear_when_supabase_is_configured(fresh_client):
    """The dev sign-in hands out a passcode in the response body.

    That is safe only because the route does not exist in a deployment. This is
    the test that keeps it that way - there is no flag to get it back, because
    there is no flag.
    """
    import app as application

    application.state["local_mode"] = False
    try:
        assert fresh_client.post(
            "/api/local/auth/otp", json={"email": "x@example.com"}
        ).status_code == 404
        assert fresh_client.get("/api/local/map").status_code == 404
        assert fresh_client.get("/api/local/notifications").status_code == 404
    finally:
        application.state["local_mode"] = True


def test_an_offline_token_is_refused_once_supabase_is_configured(monkeypatch):
    """The dev token must not survive a deployment either."""
    from core import auth

    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    assert auth.offline() is False

    class Request:
        headers = {"Authorization": f"Bearer {auth.dev_token('someone')}"}

    try:
        auth.identify(Request())
    except auth.AuthError:
        return
    raise AssertionError("a dev token was accepted against a real project")


def test_bookkeeping_and_camping_are_different_places(people):
    """A sanity anchor for the rest of the file: the map still means something."""
    akari = people("a@example.com", "あかり")
    camping = akari.post(CAMPING_A)
    books = akari.post(BOOKKEEPING)
    distance = ((camping["x"] - books["x"]) ** 2 + (camping["y"] - books["y"]) ** 2) ** 0.5
    assert distance > 100, "two unrelated posts must not land on the same island"
