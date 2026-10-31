"""規約・プライバシーポリシーの改定 (2026-11-16 施行) のお知らせと、/terms・/privacy の切り替え。

施行の前は今の文、施行のあとは新しい文を /terms・/privacy が返す。お知らせの帯は /api/config の
notice で、期間の外は null。時計は app.policy_now を差し替えて前後を確かめる。
"""

from datetime import datetime

import pytest

import app as application

JST = "+09:00"


def at(text):
    return datetime.fromisoformat(f"{text}{JST}")


@pytest.fixture
def pages(tmp_path, monkeypatch):
    """A web folder whose current and next pages say which they are."""
    for name in ("terms", "privacy"):
        (tmp_path / f"{name}.html").write_text(f"<p>{name}-now</p>", encoding="utf-8")
        (tmp_path / f"{name}-next.html").write_text(f"<p>{name}-next</p>", encoding="utf-8")
    monkeypatch.setattr(application, "WEB", tmp_path)


def set_now(monkeypatch, text):
    monkeypatch.setattr(application, "policy_now", lambda: at(text))


@pytest.mark.parametrize("page", ["terms", "privacy"])
def test_the_page_flips_at_the_effective_moment(client, pages, monkeypatch, page):
    set_now(monkeypatch, "2026-11-15T23:59:59")
    before = client.get(f"/{page}")
    assert before.status_code == 200 and f"{page}-now" in before.text
    set_now(monkeypatch, "2026-11-16T00:00:00")
    after = client.get(f"/{page}")
    assert after.status_code == 200 and f"{page}-next" in after.text
    # Revalidated every time, so an old page cannot outlive the flip.
    assert before.headers["cache-control"] == after.headers["cache-control"] == "no-cache"


@pytest.mark.parametrize("page", ["terms", "privacy"])
def test_the_next_page_is_always_there(client, pages, monkeypatch, page):
    for moment in ("2026-11-01T12:00:00", "2026-12-01T12:00:00"):
        set_now(monkeypatch, moment)
        found = client.get(f"/{page}/next")
        assert found.status_code == 200
        assert f"{page}-next" in found.text
        assert found.headers["cache-control"] == "no-cache"


def test_the_real_next_pages_are_served(client):
    for page in ("terms", "privacy"):
        found = client.get(f"/{page}/next")
        assert found.status_code == 200
        assert found.headers["content-type"].startswith("text/html")


def notice_at(client, monkeypatch, text):
    set_now(monkeypatch, text)
    return client.get("/api/config").json()["notice"]


def test_no_notice_before_the_period(client, monkeypatch):
    assert notice_at(client, monkeypatch, "2026-11-01T23:59:59") is None


def test_the_notice_before_the_effective_day(client, monkeypatch):
    notice = notice_at(client, monkeypatch, "2026-11-10T12:00:00")
    assert notice["id"] == "policy-20261116"
    assert notice["url"] == "/terms/next#changes"
    assert notice["text"].startswith("11月16日から利用規約とプライバシーポリシーが変わります")
    assert "フルネームでの登録・承認つきの招待・会の申し込み" in notice["text"]
    assert notice_at(client, monkeypatch, "2026-11-15T23:59:59")["url"] == "/terms/next#changes"


def test_the_notice_after_the_effective_day(client, monkeypatch):
    for moment in ("2026-11-16T00:00:00", "2026-11-30T23:59:00"):
        notice = notice_at(client, monkeypatch, moment)
        assert notice["id"] == "policy-20261116"
        assert notice["url"] == "/terms#changes"
        assert notice["text"] == "11月16日から新しい利用規約とプライバシーポリシーになりました"


def test_no_notice_after_the_period(client, monkeypatch):
    assert notice_at(client, monkeypatch, "2026-12-01T00:00:00") is None
