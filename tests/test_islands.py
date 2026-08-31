"""Island names are made of what people posted, not of a table of genres.

This is the seam where the two projects meet. `islands` decided a post's genre
by matching its text against twelve hand-written keyword lists - the best it
could do, because its coordinates came out of Math.random() and carried no
information at all. Here the coordinates mean something, so a landmass is named
after the words of the people standing on it, and a landmass nobody has written
anything nameable on has no name and is not drawn with one.

The map therefore starts as open water and grows names as people arrive, rather
than arriving with a set of genres nobody has posted under.
"""

import pytest

from conftest import Person
from core.clustering import name_group
from core.stopwords import DISPLAY_STOP_WORDS

MOUNTAINS_A = "山登りが好きで、週末は低山を歩いています。山頂で湯を沸かしてコーヒーを飲む時間が好きです。"
MOUNTAINS_B = "朝の山でカメラを構えるのが好きです。低山に登って山頂でコーヒーを淹れながら光を待っています。"
SOLDERING = "電子工作にはまっていて、基板を設計しています。半田付けをしながら深夜ラジオを聴くのが習慣です。"


# --------------------------------------------------------------------------
# naming, on its own
# --------------------------------------------------------------------------

IDF = {"低山": 4.0, "山頂": 3.8, "コーヒー": 2.0, "基板": 4.2, "電子工作": 4.1, "家": 1.1}


def test_a_word_the_group_shares_beats_a_rarer_one_offer():
    """Frequency times rarity. A word two people used outranks one person's."""
    name = name_group(
        [["低山", "コーヒー"], ["低山", "山頂"], ["低山"]],
        {"低山": 2.0, "コーヒー": 4.0, "山頂": 4.0},
    )
    assert name.split(" / ")[0] == "低山"


def test_rarity_decides_the_order_when_nothing_is_shared():
    """One post, so every word has the same count; the rarer one leads.

    Both words are still used: a lone island named by one word reads worse than
    one named by two, even when the second word is ordinary.
    """
    assert name_group([["基板", "家"]], IDF).split(" / ") == ["基板", "家"]


def test_display_stop_words_never_become_a_name():
    junk = sorted(DISPLAY_STOP_WORDS)[0]
    assert name_group([[junk], [junk], [junk]], {junk: 9.9}) == ""


def test_a_name_another_island_already_took_is_not_reused():
    first = name_group([["基板", "電子工作"]], IDF)
    second = name_group([["基板", "電子工作"]], IDF, taken=[first])
    assert first
    for word in first.split(" / "):
        assert word not in second.split(" / ")


def test_naming_is_stable_for_the_same_people():
    """A region must not rename itself between two polls that saw the same map."""
    lists = [["低山", "山頂"], ["低山", "コーヒー"]]
    assert name_group(lists, IDF) == name_group(lists, IDF)


def test_no_terms_means_no_name():
    assert name_group([], IDF) == ""
    assert name_group([[], []], IDF) == ""


# --------------------------------------------------------------------------
# end to end, through the API
# --------------------------------------------------------------------------

def islands_now(client):
    return client.get("/api/islands").json()["islands"]


def island_for(client, post_id):
    """The landmass a specific post is standing on, by asking the server.

    Not `min(islands, key=size)`: two separate one-post islands are the normal
    state of a quiet map, and picking between them by size is a coin toss.
    /api/neighbors answers this for one post exactly, which is also how the
    client learns it.
    """
    response = client.get(f"/api/neighbors?post={post_id}&limit=1")
    assert response.status_code == 200, response.text
    return response.json()["island"]


def bridge(client, people, *posts):
    """React until every one of `posts` is on the same landmass.

    islands' mechanism, used as a test fixture: energy widens a post's ground,
    and enough of it joins two islands into one. The number of reactions needed
    is derived from the actual gap rather than guessed, so the test says what it
    means instead of hard-coding a magic count.
    """
    from core.energy import influence_radius

    import app as application

    rows = {row["id"]: row for row in client.get("/api/local/map").json()["posts"]}
    gap = max(
        ((rows[a]["x"] - rows[b]["x"]) ** 2 + (rows[a]["y"] - rows[b]["y"]) ** 2) ** 0.5
        for a in posts for b in posts
    )
    energy = 0
    while influence_radius(energy) * 2 < gap:
        energy += 5
    fans = [people(f"fan{i}@example.com", f"fan{i}") for i in range(energy // 5 + 1)]
    for fan in fans:
        for post_id in posts:
            fan.react(post_id, "like")
    application.invalidate_islands()
    return gap


def test_an_empty_map_has_no_names_at_all(fresh_client):
    """Nothing has been written yet, so there is nothing to name."""
    assert fresh_client.get("/api/local/map").json()["posts"] == []
    assert islands_now(fresh_client) == []


def test_the_first_post_names_its_own_island(fresh_client):
    akari = Person(fresh_client, "akari@example.com", "あかり")
    placed = akari.post(MOUNTAINS_A)

    islands = islands_now(fresh_client)
    assert len(islands) == 1
    assert islands[0]["size"] == 1
    # Built from words this person actually used - not from a table of genres.
    for word in islands[0]["name"].split(" / "):
        assert word in MOUNTAINS_A, f"{word} is not in the post it claims to describe"
    assert placed["island"]["name"] == islands[0]["name"]
    assert placed["island"]["label"].endswith("島")


def test_two_related_posts_start_as_two_quiet_islands(fresh_client, people):
    """Being about the same thing is not the same as being one island.

    MOUNTAINS_A and MOUNTAINS_B are about the same hobby and land near each
    other, but a post nobody has reacted to reaches barely 35 units and the gap
    between them is wider than that. Two small islands is the correct answer,
    and it is the state the map spends most of its life in.
    """
    akari = people("akari@example.com", "あかり")
    souta = people("souta@example.com", "そうた")
    first = akari.post(MOUNTAINS_A, motivation=0)
    second = souta.post(MOUNTAINS_B, motivation=0)

    assert len(islands_now(fresh_client)) == 2
    assert island_for(fresh_client, first["id"])["name"] \
        != island_for(fresh_client, second["id"])["name"]


def test_once_their_ground_meets_they_share_one_name(fresh_client, people):
    """And that name is built from a word BOTH of them used.

    Both talk about 低山 and 山頂; neither mentions the other's private
    vocabulary. The naming rule is "how many people used it, times how rare it
    is", so a shared word has to win.
    """
    akari = people("akari@example.com", "あかり")
    souta = people("souta@example.com", "そうた")
    first = akari.post(MOUNTAINS_A, motivation=0)
    second = souta.post(MOUNTAINS_B, motivation=0)

    gap = bridge(fresh_client, people, first["id"], second["id"])

    islands = islands_now(fresh_client)
    assert len(islands) == 1, f"a {gap:.0f}-unit gap should be covered by now"
    assert islands[0]["size"] == 2
    assert any(word in MOUNTAINS_A and word in MOUNTAINS_B
               for word in islands[0]["name"].split(" / ")), (
        f"{islands[0]['name']} is not a word they share"
    )


def test_a_post_about_something_else_makes_a_second_island(fresh_client, people):
    akari = people("akari@example.com", "あかり")
    kento = people("kento@example.com", "けんと")
    akari.post(MOUNTAINS_A)
    before = len(islands_now(fresh_client))

    placed = kento.post(SOLDERING)
    assert len(islands_now(fresh_client)) == before + 1

    named = island_for(fresh_client, placed["id"])
    for word in named["name"].split(" / "):
        assert word in SOLDERING, f"{word} is not in the post it claims to describe"


def test_two_islands_never_carry_the_same_name(fresh_client):
    akari = Person(fresh_client, "akari@example.com", "あかり")
    akari.post(MOUNTAINS_A)
    akari.post(SOLDERING)
    akari.post("パン作りを習いはじめました。発酵を待つのが楽しくて、休日は台所にこもっています。")

    names = [island["name"] for island in islands_now(fresh_client)]
    assert names
    assert len(names) == len(set(names))


def test_an_island_sits_where_its_people_are(fresh_client):
    akari = Person(fresh_client, "akari@example.com", "あかり")
    souta = Person(fresh_client, "souta@example.com", "そうた")
    akari.post(MOUNTAINS_A)
    souta.post(MOUNTAINS_B)

    posts = fresh_client.get("/api/local/map").json()["posts"]
    for island in islands_now(fresh_client):
        # The centre is energy-weighted, so it must at least land inside the
        # bounding box of the posts it belongs to.
        near = [p for p in posts if abs(p["x"] - island["cx"]) < 400]
        assert near
        assert min(p["x"] for p in near) - 1 <= island["cx"] <= max(p["x"] for p in near) + 1
        assert min(p["y"] for p in near) - 1 <= island["cy"] <= max(p["y"] for p in near) + 1


def test_deleting_the_only_post_removes_the_name_again(fresh_client):
    mio = Person(fresh_client, "mio@example.com", "みお")
    placed = mio.post(
        "パン作りを習いはじめました。発酵の時間を待つのが楽しくて、休日は台所にこもっています。"
    )
    assert islands_now(fresh_client)

    assert fresh_client.delete(
        f"/api/posts/{placed['id']}", headers=mio.headers
    ).status_code == 200
    assert islands_now(fresh_client) == [], (
        "ground nobody is standing on must lose its name again"
    )


def test_reactions_can_join_two_islands_into_one(fresh_client):
    """islands' mechanism, on coordinates that mean something.

    Two posts that are related but not adjacent start as separate islands. As
    people react, each one's ground reaches further, and at some point the two
    become a single landmass with a single name built from both.
    """
    akari = Person(fresh_client, "akari@example.com", "あかり")
    souta = Person(fresh_client, "souta@example.com", "そうた")
    first = akari.post(MOUNTAINS_A, motivation=0)
    second = souta.post(SOLDERING, motivation=0)

    before = len(islands_now(fresh_client))
    assert before == 2, "unrelated posts start apart"

    # Pile energy onto both until their radii cover the gap between them.
    posts = {p["id"]: p for p in fresh_client.get("/api/local/map").json()["posts"]}
    gap = ((posts[first["id"]]["x"] - posts[second["id"]]["x"]) ** 2
           + (posts[first["id"]]["y"] - posts[second["id"]]["y"]) ** 2) ** 0.5

    from core.energy import influence_radius

    # How much energy each side needs for the two radii to meet.
    needed = 0
    while influence_radius(needed) * 2 < gap:
        needed += 5
    crowd = [
        Person(fresh_client, f"fan{index}@example.com", f"fan{index}")
        for index in range(needed // 5 + 1)
    ]
    for fan in crowd:
        fan.react(first["id"], "like")
        fan.react(second["id"], "like")

    import app as application
    application.invalidate_islands()

    after = islands_now(fresh_client)
    assert len(after) == 1, (
        f"gap {gap:.0f} should be covered once each side has {needed} energy; "
        f"got {len(after)} islands"
    )
    assert after[0]["size"] == 2


def test_a_populated_region_never_loses_its_name_as_it_grows():
    """Four people who share no vocabulary must still get a heading.

    The strict pass wants a word two of them used. When there is no such word
    the relaxed pass has to take over, or a region that already had a name goes
    unnamed the moment its fourth post arrives - a viewer sees a label vanish
    while the map is filling up, which is exactly backwards.
    """
    disjoint = [["低山"], ["基板"], ["台所"], ["ピアノ"]]
    idf = {"低山": 4.0, "基板": 4.1, "台所": 3.9, "ピアノ": 4.2}
    assert name_group(disjoint, idf) != ""


def test_a_shared_word_still_wins_once_the_region_is_crowded():
    """The fallback must not undo the rule it falls back from."""
    lists = [["登山", "低山"], ["登山", "基板"], ["登山", "台所"], ["ピアノ"]]
    idf = {"登山": 2.0, "低山": 4.0, "基板": 4.0, "台所": 4.0, "ピアノ": 4.0}
    assert name_group(lists, idf).split(" / ")[0] == "登山"
