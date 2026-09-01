"""Single source of truth for every knob that shapes the map.

These values are copied verbatim from the pokeDB pipeline (see
`C:/Users/zk-ht/pokeDB/build_umap_coords.py`), where they were selected by
ablation. The only domain-specific change in this project is the stop-word
list in `stopwords.py`: the geometry parameters stay identical.
"""

GEMINI_MODEL_NAME = "gemini-embedding-2"
GEMINI_DIMENSIONS = 384
GEMINI_TASK = "sentence similarity"

MODEL_VERSION = "kotoba-map-v2"
LAYOUT_VERSION = "parametric-isotropic-v1"

# One free-text self-introduction per person is the ONLY input signal.
FEATURE_CONFIG = {
    "dense_weight": 0.65,
    "sparse_weight": 0.35,
    "char_weight": 0.25,
    "dense_raw_weight": 0.35,
    "dense_concept_weight": 0.65,
    "word_min_df": 1,
    "word_max_features": 8000,
    "char_min_df": 1,
    "char_max_features": 6000,
    "svd_components": 64,
}

DENSE_WEIGHT = FEATURE_CONFIG["dense_weight"]
SPARSE_WEIGHT = FEATURE_CONFIG["sparse_weight"]
CHAR_WEIGHT = FEATURE_CONFIG["char_weight"]
DENSE_RAW_WEIGHT = FEATURE_CONFIG["dense_raw_weight"]
DENSE_CONCEPT_WEIGHT = FEATURE_CONFIG["dense_concept_weight"]

# Reference layout parameters for the one-off teacher UMAP run.
LAYOUT_CONFIG = {
    "n_neighbors": 15,
    "min_dist": 0.05,
    "spread": 1.0,
    "n_epochs": 1000,
    "negative_sample_rate": 10,
    "metric": "cosine",
    "init": "pca",
    "random_state": 42,
}

# Candidate island counts. The upper bound is set by how many island colours a
# reader can actually tell apart, not by anything in the data.
CLUSTER_CANDIDATES = (6, 7, 8, 9, 10)

# Size bounds are PROPORTIONAL, not absolute. pokeDB hard-coded min 15 / max 125
# for a 500-document corpus; carried over unchanged to 1000 documents, max=125
# is below N/k for every k <= 8, so no k could ever pass and the build would
# abort. These bounds are only a sanity floor anyway - the real selection is the
# score in select_cluster_model. They exist for one reason: an island holding a
# third of the corpus gets labelled with whatever is generic across a third of
# the corpus, which tells a reader nothing.
CLUSTER_MIN_RATIO = 0.02
CLUSTER_MIN_ABSOLUTE = 12
CLUSTER_MAX_RATIO = 0.35


def cluster_size_bounds(total):
    """(min, max) members per island for a corpus of `total` documents."""
    return (
        max(CLUSTER_MIN_ABSOLUTE, int(total * CLUSTER_MIN_RATIO)),
        max(CLUSTER_MIN_ABSOLUTE * 2, int(total * CLUSTER_MAX_RATIO)),
    )

# Island assignment for a new person: inverse-distance-weighted vote over the
# nearest seed points.
CLUSTER_VOTE_K = 15

MAP_MIN = 0.0
MAP_MAX = 1000.0
MAP_PADDING = 0.02
# Only literal overlaps are separated; semantic distances are never rewritten.
OVERLAP_EPSILON = 0.5

# Post rules.
#
# 140 is islands' limit on a post; 30 is the floor the embedding needs. Below 30
# characters the sparse block is mostly empty and two unrelated one-liners land
# on top of each other, which is the one thing the map must not do.
#
# There is no MAX_USERS any more. It existed because anybody with the URL could
# fill the map and the only brake was a number; accounts are the brake now.
MIN_TEXT_LENGTH = 30
MAX_TEXT_LENGTH = 140
MAX_NAME_LENGTH = 16
MAX_COMMENT_LENGTH = 500
MAX_AFFILIATION_LENGTH = 32
MAX_BIO_LENGTH = 300
MAX_LINK_LENGTH = 200

# One colour per island, so this list also caps CLUSTER_CANDIDATES.
# Hue separation matters most on avatar rings and island labels; the terrain
# dots are drawn at 0.12 alpha where hue barely reads, so ten is workable.
ISLAND_COLORS = [
    "#db2777", "#7c3aed", "#0284c7", "#059669", "#b45309",
    "#e11d48", "#4f46e5", "#15803d", "#0f766e", "#9333ea",
]
assert max(CLUSTER_CANDIDATES) <= len(ISLAND_COLORS), "島の数が色数を超えています"


# ---------------------------------------------------------------------------
# islands' post model.
#
# Everything below arrives from C:/Users/zk-ht/Downloads/islands, where posts
# carry a mood and a handful of tags and those turn into terrain. The geometry
# above is untouched by it: a tag never moves anybody, and the slider never
# does either. Only the TEXT decides where a post lands. What islands adds is
# what happens to the ground once it is there.
# ---------------------------------------------------------------------------

# Checkboxes, not radio buttons: islands moved away from a single "tense"
# choice in 2026-07-27 because people wanted to say two of these at once.
TAGS = (
    "気軽に話しかけて",
    "助けてほしい",
    "参加者募集中",
    "仲間募集中",
)

# エンジョイ (0) - ガチ (100).
MOTIVATION_MIN = 0
MOTIVATION_MAX = 100
MOTIVATION_DEFAULT = 50

# energy = motivation + interactions * ENERGY_PER_INTERACTION.
#
# islands counted likes + comments. There are three reaction kinds here, so all
# of them count: telling someone "手伝えるかも" is at least as much of a signal
# as a like, and making it worth nothing would have made the map read wrong.
ENERGY_PER_INTERACTION = 5

# radius = (ENERGY_RADIUS_BASE + energy * ENERGY_RADIUS_SCALE) * ENERGY_RADIUS_TRIM
# Verbatim from islands' MapApp.tsx: (30 + energy * 0.45) * (2 / 3). It reads
# oddly because it is two edits deep - a base radius, then a trim applied to the
# whole thing after the islands turned out too fat. Kept in that shape so the
# port can be checked against the original by eye.
ENERGY_RADIUS_BASE = 30.0
ENERGY_RADIUS_SCALE = 0.45
ENERGY_RADIUS_TRIM = 2.0 / 3.0

# Where the ground changes. Summed energy at a point in the field, not one
# post's energy: two posts side by side make forest out of what either alone
# would leave as savanna, which is the entire point of the additive field.
BIOME_THRESHOLDS = {
    "shallow": 0.05,
    "desert": 30.0,
    "savanna": 50.0,
    "plains": 90.0,
    "forest": 300.0,
    "mountain": 700.0,
}

# Drawn on the client; defined here so the server and the browser cannot drift.
BIOME_COLORS = {
    "sea": "#2FA6FF",
    "shallow": "#4BB9FF",
    "desert": "#E6CF9B",
    "savanna": "#C8B676",
    "plains": "#81C784",
    "forest": "#41A873",
    "mountain": "#34806C",
}

# Settlement glyph by interaction count. islands' table, unchanged.
PLOT_TIERS = (
    (30, "🏰"),
    (10, "🏠"),
    (5, "🛖"),
    (0, "🪵"),
)

# A landmass with this many posts is a continent rather than an island. Only
# affects the word printed after the name.
CONTINENT_MIN_POSTS = 50

# Must match the literal 20.0 in supabase/schema.sql (energy_cell_apply and
# map_cells). A generated column and an index depend on it there, and neither
# can call out to Python, so it is written twice on purpose and asserted in
# tests/test_energy.py.
ENERGY_CELL_SIZE = 20.0

# How many posts the client pulls for one viewport. Above this the terrain is
# built from the most energetic ones plus the coarse energy_cells layer.
MAP_POST_LIMIT = 800

# How many neighbours the orbit view asks for.
ORBIT_NEIGHBOR_COUNT = 24
