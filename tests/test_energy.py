"""islands' terrain rule, and the two places it has to hold at once.

The server names the landmasses and the browser paints the ground. They agree
only because both read the same constants out of /api/config, and these tests
are what stop the two from drifting - including the one number that genuinely is
written twice (the energy cell size, which a Postgres index depends on and
cannot import from Python).
"""

import json
import re
from pathlib import Path

import pytest

from core.config import (
    BIOME_THRESHOLDS,
    ENERGY_CELL_SIZE,
    ENERGY_PER_INTERACTION,
    MOTIVATION_DEFAULT,
)
from core.energy import (
    biome_at,
    computed_energy,
    constants,
    detect_landmasses,
    influence_radius,
    interaction_count,
    name_landmasses,
    plot_glyph,
    terrain_word,
    total_energy,
)

ROOT = Path(__file__).resolve().parent.parent


def post(**fields):
    base = {
        "id": fields.pop("id", "p"), "x": 0.0, "y": 0.0, "cluster_id": 0,
        "motivation": MOTIVATION_DEFAULT,
        "like_count": 0, "help_count": 0, "join_count": 0, "comment_count": 0,
    }
    base.update(fields)
    return base


# --------------------------------------------------------------------------
# the formula
# --------------------------------------------------------------------------

def test_energy_is_motivation_plus_five_per_interaction():
    """islands: motivation + interactions * 5. All three reaction kinds count."""
    quiet = post(motivation=40)
    assert computed_energy(quiet) == 40

    busy = post(motivation=40, like_count=1, help_count=2, join_count=1, comment_count=3)
    assert interaction_count(busy) == 7
    assert computed_energy(busy) == 40 + 7 * ENERGY_PER_INTERACTION


def test_a_stored_energy_is_trusted_but_a_recompute_ignores_it():
    """The pair of functions that exists because trusting the stale one is a bug.

    Postgres maintains `energy` as a generated column, so a row that came from
    the database agrees with itself and total_energy should believe it. Anything
    that has just CHANGED a count has to use computed_energy, or it derives the
    new value from the value it is replacing and nothing ever moves.
    """
    stale = post(motivation=40, like_count=3, energy=40)
    assert total_energy(stale) == 40          # believes the column
    assert computed_energy(stale) == 55       # derives it again


def test_radius_matches_islands_formula():
    """(30 + energy * 0.45) * (2 / 3), verbatim from islands' MapApp.tsx."""
    for energy in (0, 50, 100, 300, 700):
        assert influence_radius(energy) == pytest.approx((30 + energy * 0.45) * (2 / 3))
    assert influence_radius(0) == pytest.approx(20.0)


def test_biomes_band_the_summed_field_not_one_post():
    assert biome_at(0.0) is None            # open sea
    assert biome_at(0.04) is None
    assert biome_at(0.05) == "shallow"
    assert biome_at(29.9) == "shallow"
    assert biome_at(30) == "desert"
    assert biome_at(50) == "savanna"
    assert biome_at(90) == "plains"
    assert biome_at(300) == "forest"
    assert biome_at(700) == "mountain"
    assert biome_at(99999) == "mountain"


def test_biome_boundaries_are_the_configured_ones():
    """No band may start anywhere but at its own threshold."""
    for name, threshold in BIOME_THRESHOLDS.items():
        assert biome_at(threshold) == name, f"{name} must begin exactly at {threshold}"
        below = biome_at(threshold - 1e-6)
        assert below != name, f"{name} must not start below {threshold}"


def test_plot_glyph_follows_islands_tiers():
    assert plot_glyph(post()) == "🪵"
    assert plot_glyph(post(like_count=4)) == "🪵"
    assert plot_glyph(post(like_count=5)) == "🛖"
    assert plot_glyph(post(like_count=9)) == "🛖"
    assert plot_glyph(post(like_count=10)) == "🏠"
    assert plot_glyph(post(like_count=29)) == "🏠"
    assert plot_glyph(post(like_count=30)) == "🏰"
    # Comments count towards the tier too, which is the point of counting them
    # in the energy.
    assert plot_glyph(post(like_count=3, comment_count=2)) == "🛖"


def test_fifty_posts_make_a_continent():
    assert terrain_word(49) == "島"
    assert terrain_word(50) == "大陸"


# --------------------------------------------------------------------------
# landmasses
# --------------------------------------------------------------------------

def test_posts_whose_ground_overlaps_are_one_landmass():
    # Two quiet posts 30 apart. Each reaches 20 + a bit, so together they meet.
    reach = influence_radius(computed_energy(post(motivation=50)))
    assert reach * 2 > 30
    masses = detect_landmasses([
        post(id="a", x=0, y=0), post(id="b", x=30, y=0),
    ])
    assert len(masses) == 1
    assert masses[0]["size"] == 2


def test_posts_too_far_apart_stay_separate_islands():
    masses = detect_landmasses([
        post(id="a", x=0, y=0), post(id="b", x=900, y=900),
    ])
    assert len(masses) == 2
    assert {mass["size"] for mass in masses} == {1}


def test_a_chain_joins_transitively():
    """A - B - C where A and C do not touch is still one continent.

    This is what union-find buys over "everything within R of a centre", and it
    is the shape of a real conversation: people whose interests shade into one
    another belong to the same place even when the ends do not overlap.
    """
    masses = detect_landmasses([
        post(id="a", x=0, y=0), post(id="b", x=35, y=0), post(id="c", x=70, y=0),
    ])
    assert len(masses) == 1
    assert masses[0]["size"] == 3


def test_energy_widens_the_reach_enough_to_merge():
    """The same two posts, one of them busy, become one island."""
    far = [post(id="a", x=0, y=0), post(id="b", x=95, y=0)]
    assert len(detect_landmasses(far)) == 2

    busy = [post(id="a", x=0, y=0, like_count=20), post(id="b", x=95, y=0)]
    assert len(detect_landmasses(busy)) == 1, (
        "reactions are supposed to grow the land, which is how islands join"
    )


def test_the_centre_is_pulled_towards_the_busy_post():
    masses = detect_landmasses([
        post(id="a", x=0, y=0, like_count=20), post(id="b", x=40, y=0),
    ])
    assert len(masses) == 1
    assert masses[0]["cx"] < 20, "the energy-weighted centre must lean towards a"


def test_cluster_id_survives_a_merge():
    """Landmasses move; the frozen region a post sits in does not.

    The colour comes from cluster_id precisely so that two islands touching does
    not repaint the map.
    """
    masses = detect_landmasses([
        post(id="a", x=0, y=0, cluster_id=3, like_count=20),
        post(id="b", x=30, y=0, cluster_id=7),
    ])
    assert masses[0]["cluster_id"] == 3


def test_landmasses_are_ordered_biggest_first():
    masses = detect_landmasses([
        post(id="lonely", x=900, y=900),
        post(id="a", x=0, y=0), post(id="b", x=30, y=0), post(id="c", x=60, y=0),
    ])
    assert [mass["size"] for mass in masses] == [3, 1]


# --------------------------------------------------------------------------
# naming
# --------------------------------------------------------------------------

def fake_name_group(term_lists, idf, taken=()):
    """Stands in for core.clustering.name_group: most common term, not taken."""
    counts = {}
    for terms in term_lists:
        for term in set(terms or []):
            counts[term] = counts.get(term, 0) + 1
    for term in sorted(counts, key=lambda key: (-counts[key], key)):
        if term not in taken:
            return term
    return ""


def test_a_landmass_with_nothing_nameable_gets_no_label():
    """The map starts as open water and grows names, rather than arriving with
    a set of genres nobody has written anything for."""
    named = name_landmasses(
        [post(id="a", x=0, y=0, terms=[])], {}, fake_name_group,
    )
    assert named == []


def test_the_name_comes_from_the_posts_standing_on_it():
    named = name_landmasses([
        post(id="a", x=0, y=0, terms=["焚き火", "コーヒー"]),
        post(id="b", x=30, y=0, terms=["焚き火", "道具"]),
    ], {}, fake_name_group)
    assert len(named) == 1
    assert named[0]["name"] == "焚き火"
    assert named[0]["label"] == "焚き火島"
    assert named[0]["size"] == 2


def test_two_landmasses_never_take_the_same_name():
    named = name_landmasses([
        post(id="a", x=0, y=0, terms=["焚き火"]),
        post(id="b", x=30, y=0, terms=["焚き火"]),
        post(id="c", x=900, y=900, terms=["焚き火", "薪"]),
    ], {}, fake_name_group)
    names = [island["name"] for island in named]
    assert len(names) == len(set(names))
    # The bigger landmass has the better claim to the shared word.
    assert named[0]["size"] == 2
    assert named[0]["name"] == "焚き火"


# --------------------------------------------------------------------------
# the numbers that are written down twice
# --------------------------------------------------------------------------

def test_the_energy_cell_size_matches_the_sql():
    """ENERGY_CELL_SIZE is a literal in schema.sql because an index depends on it.

    Two copies of a number is a bug waiting to happen, so the bug is made to
    happen here instead of on a map where the coarse terrain layer has silently
    moved half a cell.
    """
    sql = (ROOT / "supabase" / "schema.sql").read_text(encoding="utf-8")
    literals = set(re.findall(r"/\s*([0-9]+\.[0-9]+)\s*\)::int", sql))
    literals |= set(re.findall(r"floor\([a-z_.]+ / ([0-9]+\.[0-9]+)\)", sql))
    assert literals, "expected the cell size to appear in schema.sql"
    assert literals == {f"{ENERGY_CELL_SIZE:.1f}"}, (
        f"schema.sql divides by {literals}, core/config.py says {ENERGY_CELL_SIZE}"
    )


def test_the_store_does_not_keep_its_own_copy_of_the_cell_size():
    """core/store.py used to declare ENERGY_CELL_SIZE = 20.0 of its own.

    It imports only core.energy, never core.config, so that copy was outside
    every guard in this file - and it is the one that governs local mode and
    therefore this whole test suite. A drift there would have moved the coarse
    terrain layer half a cell with all three other copies still agreeing.
    """
    source = (ROOT / "core" / "store.py").read_text(encoding="utf-8")
    assert not re.search(r"^ENERGY_CELL_SIZE\s*=", source, re.M), (
        "core/store.py declares its own ENERGY_CELL_SIZE; import it from "
        "core.config instead"
    )
    assert re.search(r"^from core\.config import .*ENERGY_CELL_SIZE", source, re.M), (
        "core/store.py must import ENERGY_CELL_SIZE from core.config"
    )

    from core import store

    assert store.ENERGY_CELL_SIZE == ENERGY_CELL_SIZE


def test_config_ships_every_constant_the_browser_draws_with():
    """web/js/config.js and web/js/map/terrain.js read these by name.

    The browser must never hard-code a copy of islands' formula: the server
    decides where a landmass is and what it is called, and a client painting
    ground from different numbers would put labels in the sea.
    """
    served = constants()
    for key in (
        "energy_per_interaction", "radius_base", "radius_scale", "radius_trim",
        "biome_order", "biome_thresholds", "biome_colors", "plot_tiers",
        "continent_min_posts",
    ):
        assert key in served, f"/api/config must carry {key}"

    assert served["biome_thresholds"] == BIOME_THRESHOLDS
    assert set(served["biome_colors"]) >= set(served["biome_order"]) | {"sea"}
    # Serialisable: this goes out as JSON on every page load.
    json.dumps(served)


# `30 + <something> * 0.45`, or a bare two-thirds trim: the shape of islands'
# radius written out by hand rather than read from /api/config. Deliberately
# narrow - 0.45 on its own is also a legitimate WebP quality step.
_HARDCODED_RADIUS = re.compile(r'30\s*\+[^;\n]*0\.45|\*\s*\(\s*2\s*/\s*3\s*\)')


def test_the_browser_does_not_hard_code_the_radius_formula():
    """Grep the client for the formula it is supposed to be served.

    The server decides where a landmass is and what it is called; the browser
    paints the ground. A second copy of `(30 + e * 0.45) * (2/3)` in JavaScript
    would agree until somebody changed one, and the symptom would be a label
    floating in the sea.
    """
    web = ROOT / "web" / "js"
    offenders = []
    for path in web.rglob("*.js"):
        source = path.read_text(encoding="utf-8")
        # Strip comments first: these files explain the formula in prose on
        # purpose, and prose is not a second implementation.
        code = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
        code = re.sub(r"^\s*//.*$", "", code, flags=re.M)
        if _HARDCODED_RADIUS.search(code):
            offenders.append(f"{path.name} (radius)")
        if "BIOME_THRESHOLD" in code:
            offenders.append(f"{path.name} (biomes)")
    assert not offenders, f"{offenders} re-implement islands' rule instead of reading it"
