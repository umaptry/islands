"""Single source of truth for every knob that shapes the map.

These values are copied verbatim from the pokeDB pipeline (see
`C:/Users/zk-ht/pokeDB/build_umap_coords.py`), where they were selected by
ablation. The only domain-specific change in this project is the stop-word
list in `stopwords.py`: the geometry parameters stay identical.
"""

MODEL_NAME = "intfloat/multilingual-e5-small"
MODEL_VERSION = "kotoba-map-v1"
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

# Profile rules.
MIN_TEXT_LENGTH = 30
MAX_TEXT_LENGTH = 2000
MAX_NAME_LENGTH = 16
MAX_USERS = 100

# One colour per island, so this list also caps CLUSTER_CANDIDATES.
# Hue separation matters most on avatar rings and island labels; the terrain
# dots are drawn at 0.12 alpha where hue barely reads, so ten is workable.
ISLAND_COLORS = [
    "#f472b6", "#a78bfa", "#38bdf8", "#34d399", "#fbbf24",
    "#fb7185", "#818cf8", "#4ade80", "#2dd4bf", "#c084fc",
]
assert max(CLUSTER_CANDIDATES) <= len(ISLAND_COLORS), "島の数が色数を超えています"
