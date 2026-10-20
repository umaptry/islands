"""What a pasted link turns into on X, LINE, Facebook, Slack (OGP, 2026-10-21)."""

import re
import struct

SITE = "https://islands-vfjsyo6oyq-an.a.run.app"


def meta(html, key):
    found = re.search(rf'<meta (?:property|name)="{re.escape(key)}" content="([^"]*)">', html)
    assert found, key
    return found.group(1)


def test_the_home_page_carries_a_card(client):
    html = client.get("/").text
    assert meta(html, "og:type") == "website"
    assert meta(html, "og:site_name") == "islands"
    assert meta(html, "og:url") == f"{SITE}/"
    assert meta(html, "twitter:card") == "summary_large_image"
    # The title says the same thing everywhere, and is short enough not to be cut.
    title = re.search(r"<title>([^<]*)</title>", html).group(1)
    assert meta(html, "og:title") == meta(html, "twitter:title") == title
    assert title.startswith("islands") and len(title) <= 40
    assert 40 <= len(meta(html, "og:description")) <= 120
    assert meta(html, "description") == meta(html, "og:description")
    # Crawlers want an absolute image URL; both cards use the same picture.
    assert meta(html, "og:image") == meta(html, "twitter:image") == f"{SITE}/static/img/og-image.png"


def test_the_card_picture_is_served_at_1200_by_630(client):
    picture = client.get("/static/img/og-image.png")
    assert picture.status_code == 200
    assert picture.headers["content-type"] == "image/png"
    body = picture.content
    assert body[:8] == b"\x89PNG\r\n\x1a\n"
    width, height = struct.unpack(">II", body[16:24])
    assert (width, height) == (1200, 630)
    html = client.get("/").text
    assert meta(html, "og:image:width") == "1200" and meta(html, "og:image:height") == "630"
    # Small enough for every service to fetch (several cap the picture at 5 MB, LINE at 1 MB).
    assert len(body) < 1_000_000
