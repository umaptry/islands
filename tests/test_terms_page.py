"""The terms of use are a page of their own, linked wherever someone agrees to them.

Signing up or signing in counts as agreeing (article 1-2), so every way in has to
show the link before the button is pressed, next to the privacy policy.
"""

import re
from datetime import datetime, timezone

import pytest


@pytest.fixture(autouse=True)
def before_the_revision(monkeypatch):
    """These check the current text, which /{page} serves only until the new one takes effect (2026-11-16)."""
    import app as application
    monkeypatch.setattr(application, "policy_now", lambda: datetime(2026, 11, 1, tzinfo=timezone.utc))


def test_the_terms_are_served(client):
    page = client.get("/terms")
    assert page.status_code == 200
    assert page.headers["content-type"].startswith("text/html")
    assert page.headers["cache-control"] == "no-cache"
    text = page.text
    assert "<title>islands — 利用規約</title>" in text
    assert "islands 運営チーム" in text
    assert 'href="mailto:' in text
    assert "制定日：" in text
    assert "改定日：2026年10月31日" in text
    assert "投稿する前の話題の確かめ" in text
    assert "押せるのは、1日に20人までです（日本時間の0時に戻ります）" in text
    assert 'href="/privacy"' in text


def test_every_article_in_the_contents_exists(client):
    text = client.get("/terms").text
    targets = set(re.findall(r'href="#(a\d+)"', text))
    ids = set(re.findall(r'id="(a\d+)"', text))
    assert targets == ids == {f"a{n}" for n in range(1, 18)}


def test_the_ways_in_link_to_the_terms(client):
    home = client.get("/").text
    welcome = home.split('<section id="welcome"', 1)[1].split("</section>", 1)[0]
    sign_in = home.split('<section id="auth"', 1)[1].split("</section>", 1)[0]
    invite = home.split('id="inviteLegal"', 1)[1].split("</p>", 1)[0]
    settings = home.split('<section id="profileEdit"', 1)[1].split("</section>", 1)[0]
    for screen in (welcome, sign_in, invite, settings):
        assert 'href="/terms"' in screen
        assert 'href="/privacy"' in screen


def test_the_privacy_policy_links_back_to_the_terms(client):
    assert 'href="/terms"' in client.get("/privacy").text
