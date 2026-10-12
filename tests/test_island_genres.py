"""Activity-genre island names (2026-10-12): the non-AI name is a genre picked by meaning.

The real encoder is never used: a stub gives each genre a one-hot vector and an
island's text the sum of the genres it mentions.
"""

from datetime import datetime, timezone

import numpy as np
import pytest

from core import island_namer, island_tracking
from core.config import ISLAND_GENRES, ISLAND_NAME_MAX_LENGTH

NOW = datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc)


def test_the_genre_list_is_short_unique_and_has_no_terrain_word():
    assert len(ISLAND_GENRES) == len(set(ISLAND_GENRES))
    assert all(1 <= len(genre) <= ISLAND_NAME_MAX_LENGTH for genre in ISLAND_GENRES)
    assert not any(word in genre for genre in ISLAND_GENRES for word in ("島", "大陸"))
    assert all(island_namer.clean_name(genre) == genre for genre in ISLAND_GENRES)


class GenreModel:
    """one-hot per genre; an island text scores every genre named in it, earlier words higher."""

    def __init__(self):
        self.calls = []

    def encode(self, texts, normalize_embeddings=True):
        self.calls.append(list(texts))
        out = []
        for text in texts:
            vector = np.full(len(ISLAND_GENRES), 1e-3)
            if text in ISLAND_GENRES:
                vector[ISLAND_GENRES.index(text)] = 1.0
            else:
                words = text.split("、")
                for rank, word in enumerate(words):
                    if word in ISLAND_GENRES:
                        vector[ISLAND_GENRES.index(word)] += 1.0 / (1 + rank)
            out.append(vector / np.linalg.norm(vector))
        return np.array(out)


@pytest.fixture
def app_module(fresh_client, monkeypatch):
    import app as application
    model = GenreModel()
    monkeypatch.setitem(application.state, "cosine_centroid", None)   # no centring
    monkeypatch.setitem(application.state, "genre_vectors", None)
    monkeypatch.setitem(application.state, "genre_warned", False)
    application.real_model = application.state["model"]
    monkeypatch.setitem(application.state, "model", model)
    application.model_stub = model
    return application


def island(name, post_ids, topics=(), cx=0.2):
    return {"name": name, "topics": list(topics), "label": f"{name}島", "cx": cx, "cy": 0.5,
            "size": len(post_ids), "energy": 0, "cluster_id": 0, "post_ids": list(post_ids),
            "author_ids": ["u1", "u2", "u3"], "regions": [{"name": "北", "label": "北地方"}]}


def posts_with(terms_by_post):
    return {pid: {"id": pid, "terms": terms} for pid, terms in terms_by_post.items()}


def test_an_island_takes_the_genre_closest_to_its_words(app_module):
    ids = ["p1", "p2", "p3"]
    posts = posts_with({pid: ["収穫", "畑"] for pid in ids})
    [named] = app_module.name_by_genre([island("トマト", ids, ["農業", "水やり"])], posts)
    assert named["name"] == "農業" and named["label"] == "農業島" and named["name_source"] == "genre"
    # the word-count words become the detail line: the old heading first, the genre itself not repeated
    assert named["topics"] == ["トマト", "水やり"]
    assert named["regions"] == [{"name": "北", "label": "北地方"}], "地方 stay word-based"


def test_a_big_island_is_a_continent_with_its_genre(app_module):
    ids = [f"p{i}" for i in range(60)]
    [named] = app_module.name_by_genre([island("山", ids, ["音楽"])], {})
    assert named["label"] == "音楽大陸"


def test_two_islands_with_the_same_best_genre_the_smaller_gets_its_second_best(app_module):
    a, b = ["a1", "a2", "a3", "a4"], ["b1", "b2"]
    posts = posts_with({"a1": [], "b1": []})
    big = island("スポーツ", a, ["釣り"])
    small = island("スポーツ", b, ["旅"], cx=0.8)
    app_module.name_by_genre([big, small], posts)         # biggest first, as name_landmasses returns them
    assert big["name"] == "スポーツ"
    assert small["name"] == "旅", "the second best, not a duplicate"
    assert big["name"] != small["name"]


def test_genre_choice_is_the_same_every_time_and_ties_go_to_the_earlier_genre(app_module):
    ids = ["p1"]
    names = []
    for _ in range(3):
        [named] = app_module.name_by_genre([island("zzz", ids)], {})
        names.append(named["name"])
    assert names == [ISLAND_GENRES[0]] * 3, "nothing matches: the list order decides"


def test_the_genres_are_encoded_once_per_process_and_the_islands_once_per_run(app_module):
    model = app_module.model_stub
    app_module.name_by_genre([island("農業", ["p1"]), island("音楽", ["p2"], cx=0.7)], {})
    assert [len(call) for call in model.calls] == [len(ISLAND_GENRES), 2]
    app_module.name_by_genre([island("農業", ["p1"])], {})
    assert [len(call) for call in model.calls] == [len(ISLAND_GENRES), 2, 1]


def test_without_an_encoder_the_word_count_names_stay_and_it_is_logged_once(app_module, monkeypatch, caplog):
    class Broken:
        def encode(self, *args, **kwargs):
            raise RuntimeError("model is down")

    monkeypatch.setitem(app_module.state, "model", Broken())
    caplog.set_level("WARNING")
    for _ in range(2):
        [kept] = app_module.name_by_genre([island("トマト", ["p1"], ["水やり"])], {})
        assert kept["name"] == "トマト" and kept["label"] == "トマト島" and kept["topics"] == ["水やり"]
        assert "name_source" not in kept
    assert sum("island genres unavailable" in record.message for record in caplog.records) == 1
    assert app_module.state["genre_vectors"] is None, "retried on the next run"


def test_live_islands_are_named_by_genre_and_a_stored_ai_name_still_wins(people, app_module, monkeypatch):
    folks = [people(f"{n}@example.com", n) for n in ("あかり", "いつき", "うみ")]
    monkeypatch.setitem(app_module.state, "model", app_module.real_model)   # posting needs the real encoder
    ids = [folks[i % 3].post(f"畑でトマトを育てて収穫しました。農業の記録 その{i}")["id"] for i in range(6)]
    monkeypatch.setitem(app_module.state, "model", app_module.model_stub)
    app_module.state["genre_vectors"] = None                                 # posting named islands with the real one
    posts = app_module.state["store"].list_terms(limit=100)
    first = app_module.live_islands(force=True)
    assert first and all(row["name_source"] == "genre" and row["name"] in ISLAND_GENRES for row in first)
    assert first[0]["label"] == first[0]["name"] + ("大陸" if first[0]["size"] >= 50 else "島")
    assert len(posts) == len(ids)

    state = app_module.state["store"]
    app_module.track_islands(now=NOW)
    [row] = [r for r in state.island_states() if r["active"]][:1]
    assert row["name_source"] == "genre" and row["name"] == first[0]["name"]
    # a stored word-count row never overrides the live genre name
    row.update(name="トマト", name_source="terms")
    shown = island_namer.overlay(first, [dict(row, post_ids=first[0]["post_ids"])])
    assert shown[0]["name"] == first[0]["name"] and shown[0]["name_source"] == "genre"
    # an AI name does
    row.update(name="手芸", name_source="ai", name_basis=first[0]["post_ids"])
    shown = island_namer.overlay([dict(first[0])], [dict(row, post_ids=first[0]["post_ids"])])
    assert shown[0]["name"] == "手芸" and shown[0]["name_source"] == "ai"


def test_an_ai_name_equal_to_a_genre_of_a_smaller_island_takes_it_over():
    a, b = [f"a{i}" for i in range(10)], [f"b{i}" for i in range(4)]
    previous = [{"id": "1", "name": "農業", "name_source": "ai", "name_basis": a, "post_ids": a}]
    live = [dict(island("トマト", a), name_source="genre"), dict(island("農業", b, cx=0.8), name_source="genre")]
    shown = island_namer.overlay(live, previous)
    assert shown[0]["name"] == "農業" and shown[0]["name_source"] == "ai"
    assert shown[1]["name"] == "" and "name_source" not in shown[1]


# -- rename events ------------------------------------------------------------

def tracked(name, source, post_ids, previous=()):
    live = [dict(island(name, post_ids), name_source=source)]
    posts = {pid: {"id": pid, "author_id": "u1", "created_at": NOW.isoformat()} for pid in post_ids}
    return island_tracking.update(list(previous), live, posts, [], now=NOW)


def renames(result):
    return [event for event in result["events"] if event["kind"] == "rename"]


def test_the_first_switch_to_a_genre_name_is_silent():
    ids = [f"p{i}" for i in range(6)]
    before = tracked("トマト", "terms", ids)
    after = tracked("農業", "genre", ids, before["states"])
    assert renames(after) == [] and after["states"][0]["name"] == "農業"
    assert after["states"][0]["name_source"] == "genre"
    # ... and between genre and ai, whatever changed
    ai = tracked("手芸", "ai", ids[:2] + ["x1", "x2", "x3", "x4"], after["states"])
    assert renames(ai) == []
    back = tracked("料理", "genre", ids[:2] + ["x1", "x2", "x3", "x4"], ai["states"])
    assert renames(back) == []


def test_a_genre_rename_is_told_only_when_the_island_itself_changed():
    ids = [f"p{i}" for i in range(6)]
    first = tracked("農業", "genre", ids)
    # 4 of 6 shared (4/8 = 0.5 >= 0.4): same island, reworded quietly
    same = tracked("料理", "genre", ids[2:] + ["n1", "n2"], first["states"])
    assert renames(same) == []
    # 4 of 6 shared but the island doubled (4/14 < 0.4, still the same island): the island changed
    moved = tracked("料理", "genre", ids[2:] + [f"n{i}" for i in range(8)], first["states"])
    [event] = renames(moved)
    assert event["before"]["name"] == "農業" and event["after"]["name"] == "料理"
    assert event["cause"] == island_tracking.CAUSES["rename_ai"]


def test_falling_back_to_the_word_count_name_is_quiet_for_the_same_island():
    ids = [f"p{i}" for i in range(6)]
    first = tracked("農業", "genre", ids)
    assert renames(tracked("トマト", "terms", ids, first["states"])) == []
