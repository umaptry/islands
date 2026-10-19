"""Where a new text stands on a map placed by its seeds (2026-10-15).

The frozen student encoder placed a post by imitating the teacher layout. With
10,182 seeds it learned the layout well at the scale of whole topics, but an
unseen post whose meaning sat near two topics landed in the sea between them:
measured on 300 held-out seeds, only 0.32 of a post's 15 nearest neighbours in
meaning were also its nearest on the map, against a ceiling of 1.0 for the
teacher itself (UMAP's own transform: 0.74). Those in-between posts filled the
gaps, and every island chained into one continent.

Here a post goes where its nearest seeds in meaning already stand. Of its k
nearest seeds (cosine in the map view, weighted by a softmax), the spot with the
heaviest weight around it (within `bandwidth`, world units) is the main group,
and the post lands at that group's weighted centre - two groups do not average
to the sea between them. Measured the same way: 0.94 of the ceiling, and the
nearest map neighbour of a labelled probe shares its family of topics 85% of
the time (the student: 82%).

The seeds are frozen with the map, so the same text still always lands on the
same spot and no post ever moves. Seed texts are never shipped: only their
map-view vectors (seed_vectors.npy) and their spots (seed_map.json "seed").

Variants (2026-10-16). People post what they do now, what they did before,
what they want to try, and events they are running. The seeds were 40% "doing
now" and 38% passing remarks, with 1% about the past and 7% announcements, so
an announcement found other announcements nearest and was carried off to them:
on the Gemini map only 46% of announcements landed by a post of their own topic
(81% of "doing now" posts). scripts/seed_variants.jsonl rewrites 1,799 seeds as
the other kinds - same topic, other kind - and each variant stands at its
source seed's spot. They never enter the teacher layout, so no region of
announcements can form; they only give a new post of that kind a nearest seed
of its own topic. With them, and the softer weighting in core.config
SEED_PLACEMENT: announcements 46% -> 65%, the past 60% -> 74%, all kinds 60% ->
67%, and the islands of 360 probe posts went from 44% to 67% one family.
"""

import numpy as np

METHOD = "seed_mode"


def placement_spots(seed_map):
    """The spots matching the rows of seed_vectors.npy: every seed, then each
    variant at its source seed's spot (seed_map "placement" "variant_sources")."""
    spots = np.array(seed_map["seed"], dtype=float)[:, :2]
    sources = np.asarray((seed_map.get("placement") or {}).get("variant_sources") or [], dtype=int)
    if len(sources) and (sources.min() < 0 or sources.max() >= len(spots)):
        raise RuntimeError("variant_sources がシードの範囲外を指しています。")
    return np.vstack([spots, spots[sources]]) if len(sources) else spots


def neighbourhood_recall(features, coords, query_features, query_coords, k=15):
    """Share of each query's k nearest in meaning that are also its k nearest
    on the map (scripts/train_parametric.neighborhood_overlap, without torch)."""
    features = np.asarray(features, dtype=np.float32)
    coords = np.asarray(coords, dtype=np.float32)
    scores = []
    for feature, coord in zip(np.asarray(query_features, dtype=np.float32), np.asarray(query_coords, dtype=np.float32)):
        meaning = set(np.argsort(-(features @ feature))[:k].tolist())
        near = set(np.argsort(np.linalg.norm(coords - coord, axis=1))[:k].tolist())
        scores.append(len(meaning & near) / k)
    return float(np.mean(scores))


def place_by_seeds(views, seed_vectors, seed_spots, k=15, temperature=0.02, bandwidth=25.0):
    """World (x, y) for one map-view vector (1-D) or a matrix of them.

    `seed_vectors` (n_seeds, d) are unit rows in the same view; `seed_spots`
    (n_seeds, 2) their world coordinates.
    """
    matrix = np.asarray(views, dtype=float)
    single = matrix.ndim == 1
    if single:
        matrix = matrix[None, :]
    similarity = matrix @ seed_vectors.T
    # A stable sort, so equal similarities always pick the same seeds.
    near = np.argsort(-similarity, axis=1, kind="stable")[:, :k]
    top = np.take_along_axis(similarity, near, 1)
    weights = np.exp((top - top[:, :1]) / temperature)
    spots = seed_spots[near]                                         # (n, k, 2)
    gaps = np.linalg.norm(spots[:, :, None, :] - spots[:, None, :, :], axis=3)
    close = gaps < bandwidth
    support = (close * weights[:, None, :]).sum(axis=2)              # weight around each spot
    centre = np.argmax(support, axis=1)                              # first maximum: deterministic
    member = close[np.arange(len(matrix)), centre] * weights
    placed = (spots * member[..., None]).sum(axis=1) / member.sum(axis=1, keepdims=True)
    return placed[0] if single else placed
