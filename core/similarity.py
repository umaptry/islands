"""Turning raw map distance into something a person can read.

Two questions the UI has to answer about any pair of people:

  "How close are we?"  -> a percentage calibrated against the seed corpus, so
                          it means "closer than N% of random pairs" rather than
                          an unanchored pixel count.
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
        return "共通の言葉はないけれど、話していることの意味が近い人です。"
    if similarity >= 40:
        return "少し離れた場所の住人。共通の言葉はまだ見つかっていません。"
    return "地図の反対側にいる人。まったく別の話をしています。"


def rank_neighbors(origin, others, quantiles, limit=3):
    """Closest `limit` entries to `origin`, annotated with similarity.

    `origin` and each entry of `others` are dicts with x / y keys.
    """
    scored = []
    for other in others:
        distance = distance_between((origin["x"], origin["y"]), (other["x"], other["y"]))
        scored.append((distance, other))
    scored.sort(key=lambda item: item[0])
    return [
        {
            **other,
            "distance": round(distance, 2),
            "similarity": similarity_percent(distance, quantiles),
        }
        for distance, other in scored[:limit]
    ]


def farthest_neighbor(origin, others, quantiles):
    if not others:
        return None
    scored = [
        (distance_between((origin["x"], origin["y"]), (other["x"], other["y"])), other)
        for other in others
    ]
    distance, other = max(scored, key=lambda item: item[0])
    return {
        **other,
        "distance": round(distance, 2),
        "similarity": similarity_percent(distance, quantiles),
    }
