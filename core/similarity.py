"""Turning raw map distance into something a person can read.

Two questions the UI has to answer about any pair of people:

  "How close are we?"  -> the cosine between the two 448-dim vectors, mapped
                          onto 0-100 against anchors measured on the seed
                          corpus. NOT the distance on the map: the map is a
                          2-D shadow of that space and this build's own gate
                          records that only 34% of true neighbours survive the
                          projection (meta.gates.generalization). Ranking by
                          map distance put a different topic at the top for 3
                          of 12 measured people; ranking by cosine got 12 of
                          12. The map is a picture; similarity is measured
                          before the squash.
                          The old map-distance path is kept below and is used
                          whenever a vector or the anchors are missing, so an
                          older artifact or an older row still renders.
  "What do we share?"  -> the words both people actually used, ranked by how
                          rare those words are in the corpus. Rare words are
                          more interesting: two people who both said 電子工作
                          have found something more specific than two people
                          who both said 音楽.
"""

import math

import numpy as np

from core.stopwords import DISPLAY_STOP_WORDS

MAX_SHARED_KEYWORDS = 5
QUANTILE_STEPS = 101  # p0..p100 inclusive

# Japanese compounds mean two people can write about the same thing and share no
# identical token: 写真部 vs 写真, フィルムカメラ vs カメラ. Matching a shorter term
# inside a longer one recovers those.
#
# The shorter side must be at least 2 characters. Allowing single characters
# turned 早朝/朝 into a shared "朝" and 英会話/会 into a shared "会" - character
# collisions, not shared interests.
#
# Semantic matching was measured and rejected: with multilingual-e5-small on
# ISOLATED words, 置く/開く scores 0.906 and 弄り/走り 0.906, against カメラ/写真
# at 0.919. No threshold separates real matches from noise, so a "近いことば"
# feature would have been roughly half junk.
MIN_SUBSTRING_MATCH = 2


def build_distance_quantiles(coords, sample_limit=200_000, seed=42):
    """Percentile table of pairwise distances across the seed corpus."""
    coords = np.asarray(coords, dtype=float)
    count = len(coords)
    total_pairs = count * (count - 1) // 2

    if total_pairs <= sample_limit:
        differences = coords[:, None, :] - coords[None, :, :]
        distances = np.linalg.norm(differences, axis=-1)
        distances = distances[np.triu_indices(count, k=1)]
    else:
        rng = np.random.default_rng(seed)
        left = rng.integers(0, count, sample_limit)
        right = rng.integers(0, count, sample_limit)
        keep = left != right
        distances = np.linalg.norm(coords[left[keep]] - coords[right[keep]], axis=1)

    percentiles = np.linspace(0.0, 100.0, QUANTILE_STEPS)
    return [round(float(value), 4) for value in np.percentile(distances, percentiles)]


def percentile_rank(distance, quantiles):
    """Fraction of seed pairs closer than `distance`, in [0, 1]."""
    table = np.asarray(quantiles, dtype=float)
    # np.interp needs an increasing x; the quantile table already is.
    positions = np.linspace(0.0, 1.0, len(table))
    return float(np.clip(np.interp(float(distance), table, positions), 0.0, 1.0))


def similarity_percent(distance, quantiles):
    """0-100. 100 means closer than essentially every seed pair."""
    return int(round(100.0 * (1.0 - percentile_rank(distance, quantiles))))


def distance_between(a, b):
    return float(math.hypot(a[0] - b[0], a[1] - b[1]))


def as_vector(value):
    """A stored `vec` as an array, or None if the row predates vectors / is empty."""
    if value is None:
        return None
    vector = np.asarray(value, dtype=float)
    if vector.ndim != 1 or vector.size == 0:
        return None
    return vector


def cosine_between(a, b):
    """Cosine of two stored vectors, or None if either is unusable.

    Both sides are L2-normalised by build_hybrid_features, so this is a dot
    product. The explicit norms cost nothing and keep the function honest if a
    row was ever written by a different path.
    """
    left, right = as_vector(a), as_vector(b)
    if left is None or right is None or left.shape != right.shape:
        return None
    scale = float(np.linalg.norm(left) * np.linalg.norm(right))
    if scale == 0.0:
        return None
    return float(np.dot(left, right) / scale)


def cosine_percent(cosine, anchors):
    """0-100 from a cosine, against the two anchors measured on the seed corpus.

    floor is the 5th percentile of random seed pairs and ceiling is the median
    seed document's distance to its own nearest neighbour, so 0 reads as "no
    more alike than two strangers" and 100 as "as close as neighbours in the
    corpus". Linear in between, which keeps the number monotone in the cosine
    and therefore never reorders the neighbour list.
    """
    floor = float(anchors["cosine_floor"])
    ceiling = float(anchors["cosine_ceiling"])
    span = ceiling - floor
    if span <= 0:  # a broken artifact must not divide by zero
        return 0
    position = (float(cosine) - floor) / span
    return int(round(100.0 * min(1.0, max(0.0, position))))


def _cosine_scores(origin_vector, others, anchors):
    """[(cosine, entry)] if every side has a vector, else None.

    All or nothing on purpose: a list where some percentages came from the
    cosine and others from the map distance would be two different scales
    printed in the same column.
    """
    if anchors is None or as_vector(origin_vector) is None:
        return None
    scored = []
    for other in others:
        cosine = cosine_between(origin_vector, other.get("vec"))
        if cosine is None:
            return None
        scored.append((cosine, other))
    return scored


def _annotated(distance, cosine, other, anchors, quantiles):
    return {
        **{key: value for key, value in other.items() if key != "vec"},
        "distance": round(distance, 2),
        "similarity": (
            cosine_percent(cosine, anchors)
            if cosine is not None
            else similarity_percent(distance, quantiles)
        ),
    }


def build_idf(token_lists):
    """Smoothed IDF over the seed corpus, used to rank shared words."""
    total = len(token_lists)
    document_frequency = {}
    for terms in token_lists:
        for term in set(terms):
            document_frequency[term] = document_frequency.get(term, 0) + 1
    return {
        term: round(math.log((total + 1) / (count + 1)) + 1.0, 4)
        for term, count in document_frequency.items()
    }


def _matches(terms_a, terms_b):
    """Terms shared between two people, allowing compound containment."""
    found = set()
    for left in set(terms_a):
        for right in set(terms_b):
            if left == right:
                found.add(left)
                continue
            shorter, longer = (left, right) if len(left) <= len(right) else (right, left)
            if len(shorter) >= MIN_SUBSTRING_MATCH and shorter in longer:
                found.add(shorter)
    return found


def shared_keywords(terms_a, terms_b, idf, limit=MAX_SHARED_KEYWORDS):
    """Words both people used, rarest first.

    A term absent from the seed corpus is treated as maximally rare: if two
    people independently used a word nobody in the corpus used, that is the
    most interesting thing they share.
    """
    default = max(idf.values()) if idf else 1.0
    found = {term for term in _matches(terms_a, terms_b) if term not in DISPLAY_STOP_WORDS}
    ranked = sorted(found, key=lambda term: (-idf.get(term, default), term))
    return ranked[:limit]


def describe_relation(similarity, shared):
    """Short Japanese caption for the bottom sheet."""
    if shared:
        return None  # the chips speak for themselves
    if similarity >= 70:
        return "同じ語は使っていませんが、意味は近いです。"
    if similarity >= 40:
        return "同じ語はまだありません。"
    return "重なるところは見つかりませんでした。"


def rank_neighbors(origin, others, quantiles, limit=3, origin_vector=None, anchors=None):
    """Closest `limit` entries to `origin`, annotated with similarity.

    `origin` and each entry of `others` are dicts with x / y keys. When every
    entry carries a `vec` and `anchors` is present, both the ordering and the
    percentage come from the 448-dim cosine; otherwise both fall back to the
    map distance. Ordering and percentage always come from the same measure, so
    the top of the list is always the largest number in it.
    """
    scored = _cosine_scores(origin_vector, others, anchors)
    if scored is not None:
        scored.sort(key=lambda item: -item[0])
        return [
            _annotated(
                distance_between((origin["x"], origin["y"]), (other["x"], other["y"])),
                cosine, other, anchors, quantiles,
            )
            for cosine, other in scored[:limit]
        ]

    by_distance = sorted(
        (
            (distance_between((origin["x"], origin["y"]), (other["x"], other["y"])), other)
            for other in others
        ),
        key=lambda item: item[0],
    )
    return [
        _annotated(distance, None, other, anchors, quantiles)
        for distance, other in by_distance[:limit]
    ]


def farthest_neighbor(origin, others, quantiles, origin_vector=None, anchors=None):
    if not others:
        return None
    scored = _cosine_scores(origin_vector, others, anchors)
    if scored is not None:
        cosine, other = min(scored, key=lambda item: item[0])
        distance = distance_between((origin["x"], origin["y"]), (other["x"], other["y"]))
        return _annotated(distance, cosine, other, anchors, quantiles)

    distance, other = max(
        (
            (distance_between((origin["x"], origin["y"]), (other["x"], other["y"])), other)
            for other in others
        ),
        key=lambda item: item[0],
    )
    return _annotated(distance, None, other, anchors, quantiles)
