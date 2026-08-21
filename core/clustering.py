"""Islands: k-means over the published map, labelled with word pairs.

Ported from pokeDB. Two decisions carried over verbatim, both measured there:

  * Cluster the PUBLISHED 2-D COORDINATES, not the 448-dim features. Clustering
    the features produced regions that cut across the layout (silhouette 0.04,
    inter/intra 1.07), so the coloured regions matched nothing a reader could
    see. Clustering position keeps one source of truth.
  * A label is a PAIR (occasionally a triple) of words scored by
    0.45*relevance + 0.35*semantic + 0.20*co-occurrence, so the heading reads
    like a place name rather than one ambiguous word.
"""

import itertools
import math
from collections import Counter
from difflib import SequenceMatcher

import numpy as np
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score

from core.config import CLUSTER_CANDIDATES, CLUSTER_VOTE_K, cluster_size_bounds
from core.features import _SPLIT_MODE, display_term, get_tokenizer, make_label_candidates
from core.stopwords import DISPLAY_STOP_WORDS, GENERAL_STOP_WORDS, LABEL_ONLY_STOP_WORDS

MAX_RANKED_TERMS = 20
# Serving-time naming. Deliberately NOT rank_cluster_keywords: that one embeds
# every candidate term to score the pair semantically, which is right for a
# once-per-build pass over 1,000 documents and far too slow to run while
# somebody waits for their join to come back.
LIVE_LABEL_TERMS = 2
PAIR_SEMANTIC_FLOOR = 0.28
TRIPLE_SEMANTIC_FLOOR = 0.32
TRIPLE_MARGIN = 0.015


def _near_duplicate(left, right):
    a = display_term(left).lower()
    b = display_term(right).lower()
    if a in b or b in a:
        return True
    reading_a = "".join(m.reading_form() for m in get_tokenizer().tokenize(a, _SPLIT_MODE))
    reading_b = "".join(m.reading_form() for m in get_tokenizer().tokenize(b, _SPLIT_MODE))
    if reading_a and reading_a == reading_b:
        return True
    return SequenceMatcher(None, a, b).ratio() >= 0.82


def name_group(term_lists, idf, taken=()):
    """Name an island from the words the people on it actually used.

    Scored as (how many of them said it) x (how rare it is in the corpus).
    Frequency alone crowns whatever word is commonest everywhere; rarity alone
    crowns a single person's one-off. The product is the usual balance, and it
    reuses the same idf table and the same noun-only `terms` that the shared-word
    chips are built from - so an island is named in the vocabulary a reader has
    already seen elsewhere in the UI.

    `taken` are names already used by other islands: two islands called the same
    thing would be worse than one of them being named less well.

    Returns "A / B", or "A", or "" when there is nothing worth saying.
    """
    lists = [list(terms or []) for terms in term_lists]
    if not lists:
        return ""

    document_frequency = Counter()
    for terms in lists:
        for term in set(terms):
            if term and term not in DISPLAY_STOP_WORDS:
                document_frequency[term] += 1
    if not document_frequency:
        return ""

    # A word only one person used is fine when the island IS one or two people,
    # and noise once it is a crowd.
    minimum_support = 1 if len(lists) < 4 else 2
    default_idf = max(idf.values()) if idf else 1.0
    scored = [
        (count * float(idf.get(term, default_idf)), term)
        for term, count in document_frequency.items()
        if count >= minimum_support
    ]
    if not scored:
        return ""
    # Sort by score, then by term, so the same island never renames itself
    # between two requests that saw the same people.
    scored.sort(key=lambda pair: (-pair[0], pair[1]))

    blocked = set()
    for name in taken:
        blocked.update(part.strip() for part in str(name).split("/"))

    chosen = []
    for _score, term in scored:
        if term in blocked:
            continue
        if any(_near_duplicate(term, picked) for picked in chosen):
            continue
        chosen.append(term)
        if len(chosen) == LIVE_LABEL_TERMS:
            break
    return " / ".join(display_term(term) for term in chosen)


def _positive_npmi(left, right, document_sets, global_df):
    total = len(document_sets)
    both = sum(left in doc and right in doc for doc in document_sets)
    if both == 0:
        return 0.0
    px = global_df[left] / total
    py = global_df[right] / total
    pxy = both / total
    value = math.log(pxy / (px * py)) / -math.log(pxy)
    # Rare one-off co-occurrences otherwise receive an unrealistically perfect NPMI.
    confidence = min(1.0, both / 3.0)
    return float(max(0.0, min(1.0, value)) * confidence)


def rank_cluster_keywords(labels, cluster_id, token_lists, model, embedding_cache):
    member_indices = np.where(labels == cluster_id)[0]
    cluster_size = len(member_indices)
    minimum_support = max(2, math.ceil(cluster_size * 0.04))
    per_doc_candidates = [set(make_label_candidates(tokens)) for tokens in token_lists]
    global_df = Counter(term for terms in per_doc_candidates for term in terms)
    cluster_df = Counter(term for i in member_indices for term in per_doc_candidates[i])

    relevance = {}
    for term, support in cluster_df.items():
        shown = display_term(term)
        if support < minimum_support or shown in GENERAL_STOP_WORDS or shown in LABEL_ONLY_STOP_WORDS:
            continue
        specificity = math.log((len(token_lists) + 1) / (global_df[term] + 1))
        relevance[term] = (support / cluster_size) * specificity
    if len(relevance) < 2:
        return None

    ranked = sorted(relevance, key=relevance.get, reverse=True)[:MAX_RANKED_TERMS]
    max_relevance = max(relevance[term] for term in ranked) or 1.0
    normalized_relevance = {term: relevance[term] / max_relevance for term in ranked}

    missing = [term for term in ranked if term not in embedding_cache]
    if missing:
        vectors = model.encode(
            [f"query: {display_term(term)}" for term in missing],
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        embedding_cache.update(zip(missing, vectors))

    # The triple loop re-asks for the same pairs ~3x each, and every NPMI call
    # scans all documents. At N=1000 that dominates the build, so memoize.
    pair_cache = {}

    def pair_metrics(left, right):
        key = (left, right)
        if key not in pair_cache:
            semantic = float(max(0.0, np.dot(embedding_cache[left], embedding_cache[right])))
            pair_cache[key] = (
                semantic, _positive_npmi(left, right, per_doc_candidates, global_df)
            )
        return pair_cache[key]

    best_pair = None
    for terms in itertools.combinations(ranked, 2):
        if _near_duplicate(*terms):
            continue
        semantic, cooccurrence = pair_metrics(*terms)
        if semantic < PAIR_SEMANTIC_FLOOR and cooccurrence == 0.0:
            continue
        rel = sum(normalized_relevance[t] for t in terms) / 2
        score = 0.45 * rel + 0.35 * semantic + 0.20 * cooccurrence
        if best_pair is None or score > best_pair[0]:
            best_pair = (score, terms, semantic, cooccurrence)
    if best_pair is None:
        return None

    selected = best_pair
    for terms in itertools.combinations(ranked, 3):
        if any(_near_duplicate(a, b) for a, b in itertools.combinations(terms, 2)):
            continue
        pairs = [pair_metrics(a, b) for a, b in itertools.combinations(terms, 2)]
        mean_semantic = float(np.mean([pair[0] for pair in pairs]))
        mean_npmi = float(np.mean([pair[1] for pair in pairs]))
        if min(pair[0] for pair in pairs) < TRIPLE_SEMANTIC_FLOOR and mean_npmi == 0.0:
            continue
        rel = sum(normalized_relevance[t] for t in terms) / 3
        score = 0.45 * rel + 0.35 * mean_semantic + 0.20 * mean_npmi
        if score >= selected[0] + TRIPLE_MARGIN:
            selected = (score, terms, mean_semantic, mean_npmi)

    score, terms, semantic, cooccurrence = selected
    return {
        "top_words": [display_term(term) for term in terms],
        "keywords": " / ".join(display_term(term) for term in terms),
        "coherence_score": round(float(0.65 * semantic + 0.35 * cooccurrence), 4),
        "selection_score": round(float(score), 4),
        "minimum_support": minimum_support,
    }


def select_cluster_model(matrix, token_lists, model, metric="euclidean", verbose=True):
    """Pick the island count that is both visually separated and nameable."""
    candidates = []
    embedding_cache = {}
    min_size, max_size = cluster_size_bounds(len(matrix))
    if verbose:
        print(f"島サイズの許容範囲: {min_size}〜{max_size} 件 (N={len(matrix)})")
    for cluster_count in CLUSTER_CANDIDATES:
        clusterer = KMeans(n_clusters=cluster_count, n_init=20, random_state=42)
        labels = clusterer.fit_predict(matrix)
        counts = np.bincount(labels, minlength=cluster_count)
        if int(counts.min()) < min_size or int(counts.max()) > max_size:
            if verbose:
                print(f"k={cluster_count}: rejected by size bounds {counts.tolist()}")
            continue

        keyword_meta = []
        valid = True
        for cluster_id in range(cluster_count):
            meta = rank_cluster_keywords(labels, cluster_id, token_lists, model, embedding_cache)
            if meta is None:
                if verbose:
                    print(f"k={cluster_count}: cluster {cluster_id} has no coherent label pair")
                valid = False
                break
            keyword_meta.append(meta)
        if not valid:
            continue

        silhouette = float(silhouette_score(matrix, labels, metric=metric))
        normalized_silhouette = (silhouette + 1.0) / 2.0
        probabilities = counts / counts.sum()
        entropy = float(-np.sum(probabilities * np.log(probabilities)) / math.log(cluster_count))
        label_coherence = float(np.mean([meta["coherence_score"] for meta in keyword_meta]))
        total_score = 0.50 * normalized_silhouette + 0.35 * label_coherence + 0.15 * entropy
        candidates.append({
            "cluster_count": cluster_count,
            "labels": labels,
            "counts": counts,
            "keyword_meta": keyword_meta,
            "silhouette": silhouette,
            "size_entropy": entropy,
            "label_coherence": label_coherence,
            "selection_score": total_score,
        })
        if verbose:
            names = [meta["keywords"] for meta in keyword_meta]
            print(
                f"k={cluster_count}: score={total_score:.4f}, silhouette={silhouette:.4f}, "
                f"coherence={label_coherence:.4f}, entropy={entropy:.4f}, sizes={counts.tolist()}"
            )
            print(f"    labels={names}")
    if not candidates:
        raise RuntimeError(
            f"No k in {list(CLUSTER_CANDIDATES)} passed the cluster size and keyword coherence gates"
        )

    candidates.sort(key=lambda item: (-item["selection_score"], item["cluster_count"]))
    best = candidates[0]
    if verbose:
        print(f"Selected k={best['cluster_count']} with score={best['selection_score']:.4f}")
    return best


def sort_clusters_by_position(labels, coords, cluster_count):
    """Renumber clusters top-to-bottom then left-to-right so IDs stay stable."""
    coords = np.asarray(coords, dtype=float)
    centroids = np.array([coords[labels == cid].mean(axis=0) for cid in range(cluster_count)])
    order = sorted(range(cluster_count), key=lambda cid: (centroids[cid][1], centroids[cid][0]))
    remap = {old: new for new, old in enumerate(order)}
    return np.array([remap[int(label)] for label in labels]), order


def assign_cluster(x, y, seed_coords, seed_clusters, k=CLUSTER_VOTE_K):
    """Island for a new point: inverse-distance-weighted vote over k nearest seeds.

    Used at serving time. It refits nothing, so it cannot move the map.
    """
    seed_coords = np.asarray(seed_coords, dtype=float)
    distances = np.linalg.norm(seed_coords - np.array([x, y], dtype=float), axis=1)
    nearest = np.argsort(distances)[:k]
    votes = {}
    for index in nearest:
        cluster_id = int(seed_clusters[index])
        votes[cluster_id] = votes.get(cluster_id, 0.0) + 1.0 / (float(distances[index]) + 1.0)
    return max(votes, key=votes.get)
