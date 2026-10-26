"""The privacy policy is a page of its own, linked from the ways in.

Google will not publish the sign-in consent screen without a privacy policy URL
on the app's own domain, linked from the home page.
"""

import re


def test_the_privacy_policy_is_served(client):
    page = client.get("/privacy")
    assert page.status_code == 200
    assert page.headers["content-type"].startswith("text/html")
    assert page.headers["cache-control"] == "no-cache"
    text = page.text
    assert "<title>islands — プライバシーポリシー</title>" in text
    # Who runs it, where to write, and since when: the law asks for all three.
    assert "islands 運営チーム" in text
    assert 'href="mailto:' in text
    assert "制定日：2026年10月20日" in text
    assert "1日に押した人数" in text
    assert "1日に押した人数の記録は、2日たつと消します" in text
    # What Google asks the policy to say about the data it hands over.
    assert "Google API Services User Data Policy" in text
    assert "Limited Use" in text


def test_every_chapter_in_the_contents_exists(client):
    text = client.get("/privacy").text
    targets = set(re.findall(r'href="#(s\d+)"', text))
    ids = set(re.findall(r'id="(s\d+)"', text))
    assert targets == ids == {f"s{n}" for n in range(1, 14)}


def test_the_ways_in_link_to_the_privacy_policy(client):
    home = client.get("/").text
    welcome = home.split('<section id="welcome"', 1)[1].split("</section>", 1)[0]
    sign_in = home.split('<section id="auth"', 1)[1].split("</section>", 1)[0]
    settings = home.split('<section id="profileEdit"', 1)[1].split("</section>", 1)[0]
    for screen in (welcome, sign_in, settings):
        assert 'href="/privacy"' in screen
