"""Island names are made of what people posted, not of the seed corpus.

The map used to arrive with ten fixed genres already printed on it, and joining
only ever dropped a dot onto one of them. Now a region has a name only once
somebody has posted in it, and the name is built from their words - so these
tests are about the thing the map is supposed to demonstrate, not about
plumbing.
"""

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ["KOTOBA_DISABLE_RATE_LIMIT"] = "1"

pytest.importorskip("fastapi")

from core.clustering import name_group  # noqa: E402
from core.stopwords import DISPLAY_STOP_WORDS  # noqa: E402

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

@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient

    import app as application

    with TestClient(application.app) as test_client:
        yield test_client


def join(client, name, text):
    response = client.post(
        "/api/join", json={"icon_id": "1", "name": name, "text": text}
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_an_empty_map_has_no_genres_at_all(client):
    """Nothing has been written yet, so there is nothing to name."""
    payload = client.get("/api/map").json()
    assert payload["users"] == []
    assert payload["islands"] == []


def test_the_first_post_names_its_own_island(client):
    joined = join(client, "あかり", MOUNTAINS_A)
    islands = client.get("/api/map").json()["islands"]
    assert len(islands) == 1
    assert islands[0]["size"] == 1
    assert islands[0]["id"] == joined["cluster_id"]
    # Built from words this person actually used.
    for word in islands[0]["name"].split(" / "):
        assert word in MOUNTAINS_A, f"{word} is not in the post it claims to describe"
    assert joined["island"]["name"] == islands[0]["name"]


def test_a_second_post_in_the_same_region_renames_it_around_the_pair(client):
    join(client, "そうた", MOUNTAINS_B)
    islands = {island["id"]: island for island in client.get("/api/map").json()["islands"]}
    mountains = max(islands.values(), key=lambda island: island["size"])
    assert mountains["size"] == 2
    # Both posts talk about 低山 and 山頂; neither mentions the other's private
    # vocabulary, so a shared word has to win.
    assert any(word in MOUNTAINS_A and word in MOUNTAINS_B
               for word in mountains["name"].split(" / "))


def test_a_post_elsewhere_adds_a_second_genre(client):
    before = len(client.get("/api/map").json()["islands"])
    joined = join(client, "けんと", SOLDERING)
    islands = client.get("/api/map").json()["islands"]
    assert len(islands) == before + 1
    named = next(island for island in islands if island["id"] == joined["cluster_id"])
    for word in named["name"].split(" / "):
        assert word in SOLDERING


def test_two_islands_never_carry_the_same_name(client):
    names = [island["name"] for island in client.get("/api/map").json()["islands"]]
    assert names
    assert len(names) == len(set(names))


def test_an_island_sits_where_its_people_are(client):
    payload = client.get("/api/map").json()
    for island in payload["islands"]:
        members = [user for user in payload["users"] if user["cluster_id"] == island["id"]]
        assert members
        assert island["cx"] == pytest.approx(
            sum(member["x"] for member in members) / len(members), abs=0.02
        )
        assert island["cy"] == pytest.approx(
            sum(member["y"] for member in members) / len(members), abs=0.02
        )


def test_leaving_removes_the_genre_that_only_that_post_supported(client):
    joined = join(client, "みお", "パン作りを習いはじめました。発酵の時間を待つのが楽しくて、休日は台所にこもっています。")
    islands = client.get("/api/map").json()["islands"]
    assert any(island["id"] == joined["cluster_id"] for island in islands)

    response = client.post(
        "/api/leave", json={"id": joined["id"], "edit_token": joined["edit_token"]}
    )
    assert response.status_code == 200, response.text

    after = client.get("/api/map").json()["islands"]
    assert not any(island["id"] == joined["cluster_id"] for island in after), (
        "a region nobody is standing in must lose its name again"
    )


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
