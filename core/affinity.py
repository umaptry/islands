"""How alike two people are, from what they say about themselves and what they post.

Four parts, weighted by AFFINITY_WEIGHTS in core/config.py:

  topics            - the words they listed, embedded together
  goal              - one sentence about what they are working towards
  seeking_offering  - what one is looking for against what the other can give,
                      in whichever direction fits better
  posts             - the mean of their centred post vectors, through the same
                      cosine_percent the profile sheet already prints

Profile vectors are stored as the encoder returns them and centred only when
compared (the seed corpus's dense mean is subtracted, as for posts), so a new
seed build re-centres every profile without re-embedding any of them.

A part either person left empty is dropped and the remaining weights are
renormalised, so filling in a field can only make a match more informed, never
punish the people who skipped it. Where a person stands on the MAP is still
decided by their posts alone; none of this moves anybody.

This is the only implementation. There is no SQL copy, on purpose.
"""

import os
import unicodedata

import numpy as np

from core.config import (
    AFFINITY_WEIGHTS,
    PROFILE_COSINE_ANCHORS,
    PROFILE_TEXT_FIELDS,
    SIMILAR_PEOPLE_COUNT,
)
from core.similarity import cosine_percent

VECTOR_FIELDS = ("topics",) + PROFILE_TEXT_FIELDS


def normalise_topic(word):
    return unicodedata.normalize("NFKC", str(word)).strip().lower()


def profile_texts(fields):
    """The text each profile vector is computed from, or None when empty."""
    topics = [str(t).strip() for t in (fields.get("topics") or []) if str(t).strip()]
    texts = {"topics": "、".join(topics) or None}
    for key in PROFILE_TEXT_FIELDS:
        value = (fields.get(key) or "").strip()
        texts[key] = value or None
    return texts


def embed_profile(model, fields):
    """{"vec_topics": [...] | None, ...} for the fields present, in ONE encode call.

    One call matters for Gemini: a save is one request rather than four.
    """
    texts = profile_texts(fields)
    present = [key for key in VECTOR_FIELDS if texts[key]]
    vectors = {f"vec_{key}": None for key in VECTOR_FIELDS}
    if not present:
        return vectors
    encoded = model.encode([texts[key] for key in present], normalize_embeddings=True)
    for key, row in zip(present, np.asarray(encoded, dtype=float)):
        vectors[f"vec_{key}"] = [round(float(value), 6) for value in row]
    return vectors


def profile_anchors(provider=None):
    provider = provider or os.environ.get("EMBEDDING_PROVIDER", "onnx")
    return PROFILE_COSINE_ANCHORS.get(provider, PROFILE_COSINE_ANCHORS["onnx"])


def centre(vector, dense_mean):
    """The vector with the seed mean taken off, or unchanged if that is not possible."""
    if vector is None or dense_mean is None:
        return vector
    values = np.asarray(vector, dtype=float)
    mean = np.asarray(dense_mean, dtype=float)
    if values.shape != mean.shape:
        return vector
    residual = values - mean
    if float(np.linalg.norm(residual)) < 1e-6:
        return vector
    return residual


def _cosine(a, b, dense_mean=None):
    if a is None or b is None:
        return None
    a = np.asarray(centre(a, dense_mean), dtype=float)
    b = np.asarray(centre(b, dense_mean), dtype=float)
    if a.shape != b.shape:
        return None
    scale = float(np.linalg.norm(a) * np.linalg.norm(b))
    if scale == 0.0:
        return None
    return float(np.dot(a, b) / scale)


def _rescale(cosine, anchors):
    if cosine is None:
        return None
    floor, ceiling = anchors
    if ceiling <= floor:
        return 0.0
    return float(min(1.0, max(0.0, (cosine - floor) / (ceiling - floor))))


def affinity(a, b, profile_anchor=None, post_anchors=None, weights=None, dense_mean=None):
    """Score 0..1 between two people, with the parts that made it.

    a and b are dicts with vec_topics / vec_goal / vec_seeking / vec_offering
    (lists or None), `centroid` (mean centred post vector or None) and `topics`.
    dense_mean is state["cosine_centroid"]["dense_mean"]; without it profile
    vectors are compared raw, which the anchors are NOT measured for.
    Returns None when the two have no part in common to compare.
    """
    weights = weights or AFFINITY_WEIGHTS
    anchors = profile_anchor or profile_anchors()
    parts = {
        "topics": _rescale(_cosine(a.get("vec_topics"), b.get("vec_topics"), dense_mean), anchors),
        "goal": _rescale(_cosine(a.get("vec_goal"), b.get("vec_goal"), dense_mean), anchors),
    }
    either = [value for value in directions(a, b, anchors, dense_mean) if value is not None]
    parts["seeking_offering"] = max(either) if either else None
    post_cosine = _cosine(a.get("centroid"), b.get("centroid"))
    if post_cosine is not None and post_anchors is not None:
        parts["posts"] = cosine_percent(post_cosine, post_anchors) / 100.0
    else:
        parts["posts"] = None

    used = {key: value for key, value in parts.items() if value is not None and weights.get(key, 0) > 0}
    if not used:
        return None
    total = sum(weights[key] for key in used)
    score = sum(weights[key] * value for key, value in used.items()) / total

    mine = {normalise_topic(t): t for t in (a.get("topics") or [])}
    shared = [mine[key] for key in (normalise_topic(t) for t in (b.get("topics") or [])) if key in mine]
    return {"score": round(score, 4), "parts": {k: (None if v is None else round(v, 4)) for k, v in parts.items()},
            "shared_topics": shared}


def directions(a, b, profile_anchor=None, dense_mean=None):
    """(how well b offers what a seeks, how well a offers what b seeks), each 0..1 or None.

    affinity() keeps only the better of the two; a reason in words needs to
    know which way round it was (core/introductions.py).
    """
    anchors = profile_anchor or profile_anchors()
    return (
        _rescale(_cosine(a.get("vec_seeking"), b.get("vec_offering"), dense_mean), anchors),
        _rescale(_cosine(b.get("vec_seeking"), a.get("vec_offering"), dense_mean), anchors),
    )


def rank_similar(me, people, limit=SIMILAR_PEOPLE_COUNT, **kwargs):
    """The `limit` people most like `me`, best first. `people` includes anybody."""
    ranked = []
    for other in people:
        if other["id"] == me["id"]:
            continue
        result = affinity(me, other, **kwargs)
        if result is None:
            continue
        ranked.append({"id": other["id"], **result})
    ranked.sort(key=lambda row: (-row["score"], row["id"]))
    return ranked[:limit]


__all__ = ["VECTOR_FIELDS", "affinity", "centre", "directions", "embed_profile", "normalise_topic",
           "profile_anchors", "profile_texts", "rank_similar"]
