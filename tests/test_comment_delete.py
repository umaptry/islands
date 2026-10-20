"""Deleting your own message goes through the server (2026-10-21).

In production the browser used to PATCH comments.deleted_at itself; the row
then fell outside the comments_read policy and the database refused the update
("new row violates row-level security policy"). DELETE /api/comments/{id}
does it with the store's own key, after checking the author.
"""

from pathlib import Path

CAMPING = "週末に仲間とキャンプへ行きます。一緒に行ける人を募集しています。"


def comment_ids(client, post_id):
    rows = client.get(f"/api/local/comments?post={post_id}").json()["comments"]
    return [row["id"] for row in rows]


def test_the_author_deletes_a_message_and_the_post_gives_it_back(people):
    akari = people("a@example.com", "あかり")
    bannai = people("b@example.com", "ばんない")
    post = akari.post(CAMPING)
    comment = bannai.comment(post["id"], "いいですね").json()
    assert comment_ids(akari.client, post["id"]) == [comment["id"]]

    deleted = bannai.client.delete(f"/api/comments/{comment['id']}", headers=bannai.headers)
    assert deleted.status_code == 200, deleted.text
    assert deleted.json() == {"ok": True}
    assert comment_ids(akari.client, post["id"]) == []


def test_someone_else_cannot_delete_it_and_twice_is_refused(people):
    akari = people("a@example.com", "あかり")
    bannai = people("b@example.com", "ばんない")
    post = akari.post(CAMPING)
    comment = bannai.comment(post["id"], "いいですね").json()

    # Not even the post's author: the message is bannai's words.
    refused = akari.client.delete(f"/api/comments/{comment['id']}", headers=akari.headers)
    assert refused.status_code == 403
    assert comment_ids(akari.client, post["id"]) == [comment["id"]]

    assert bannai.client.delete(f"/api/comments/{comment['id']}", headers=bannai.headers).status_code == 200
    again = bannai.client.delete(f"/api/comments/{comment['id']}", headers=bannai.headers)
    assert again.status_code == 403


def test_a_malformed_id_is_refused_rather_than_read_as_an_outage(people):
    bannai = people("b@example.com", "ばんない")
    response = bannai.client.delete("/api/comments/not-an-id", headers=bannai.headers)
    assert response.status_code == 403


def test_signed_out_is_asked_to_sign_in(people):
    akari = people("a@example.com", "あかり")
    post = akari.post(CAMPING)
    comment = akari.comment(post["id"], "よろしくお願いします").json()
    response = akari.client.delete(f"/api/comments/{comment['id']}")
    assert response.status_code == 401


def test_the_browser_no_longer_patches_deleted_at_on_comments():
    """The deployed path (net.js, the Supabase backend) asks the server."""
    source = (Path(__file__).resolve().parents[1] / "web" / "js" / "net.js").read_text(encoding="utf-8")
    start = source.index("async deleteComment(")
    body = source[start:source.index("},", start)]
    assert "/api/comments/" in body
    assert "deleted_at" not in body
