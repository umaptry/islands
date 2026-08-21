"""Text -> 448-dimensional vector.

Ported from pokeDB (build_umap_coords.py, lines 105-240). Two complementary
views of the same sentence are fused:

  A. sparse  (64 dims) - which words were used. Sudachi lemmas -> word TF-IDF
     (1-2gram) hstacked with character TF-IDF (2-4gram, weighted 0.25) ->
     TruncatedSVD(64). Sudachi is a tokenizer/lemmatizer here, NOT a source of
     word vectors.
  B. dense   (384 dims) - what the sentence means, from multilingual-e5-small.
     Encoded twice: the raw sentence AND a content-words-only pseudo-sentence.
     Blended 0.35 raw : 0.65 concept, because self-introductions share a lot of
     stylistic phrasing and embedding the raw sentence alone clusters by style.

  fused = L2( [dense * 0.65, sparse * 0.35] )   -> 448 dims
"""

import re
import threading

import numpy as np
import scipy.sparse as sp
from sklearn.decomposition import TruncatedSVD
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.preprocessing import normalize
from sudachipy import dictionary, tokenizer

from core.config import (
    CHAR_WEIGHT,
    DENSE_CONCEPT_WEIGHT,
    DENSE_RAW_WEIGHT,
    DENSE_WEIGHT,
    FEATURE_CONFIG,
    SPARSE_WEIGHT,
)
from core.stopwords import GENERAL_STOP_WORDS, LABEL_ONLY_STOP_WORDS

ALLOWED_POS = {"名詞", "動詞", "形容詞"}
EXCLUDED_SUBPOS = {"代名詞", "数詞", "助数詞可能", "接尾辞", "形式名詞"}

# SudachiPy's Tokenizer is a Rust object with RefCell semantics: two threads
# calling tokenize() on the same instance raise `RuntimeError: Already
# borrowed`. FastAPI runs every sync endpoint in a threadpool and Cloud Run
# gives one process a concurrency of 12, so a shared singleton turned
# simultaneous joins into 500s - measured at 6 failures out of 12 people
# submitting at once, and again inside island naming via _near_duplicate.
#
# The dictionary is the expensive half (the lexicon) and stays shared; create()
# off it is cheap, so every thread gets its own tokenizer.
_DICTIONARY = None
_DICTIONARY_LOCK = threading.Lock()
_LOCAL = threading.local()
_SPLIT_MODE = tokenizer.Tokenizer.SplitMode.C

_EDGE_PUNCT = re.compile(r"^[\W_]+|[\W_]+$", flags=re.UNICODE)
_SINGLE_KANJI = re.compile(r"[一-龯]")
_HAS_LETTER = re.compile(r"[一-龯ぁ-んァ-ヶーA-Za-z]")
_WHITESPACE = re.compile(r"\s+")


def get_tokenizer():
    """The tokenizer for THIS thread. Never share one across threads."""
    instance = getattr(_LOCAL, "tokenizer", None)
    if instance is None:
        global _DICTIONARY
        with _DICTIONARY_LOCK:
            if _DICTIONARY is None:
                _DICTIONARY = dictionary.Dictionary()
        instance = _LOCAL.tokenizer = _DICTIONARY.create()
    return instance


def normalize_text(text):
    return _WHITESPACE.sub(" ", (text or "").replace("\n", " ").replace("\f", " ")).strip()


def is_meaningful_term(term):
    """Keep content words, including single-kanji concepts such as 山 or 畑."""
    if not term or term in GENERAL_STOP_WORDS or term.isdigit():
        return False
    if len(term) < 2 and not _SINGLE_KANJI.fullmatch(term):
        return False
    return bool(_HAS_LETTER.search(term))


def _lemmas(text, allowed_pos):
    terms = []
    for morpheme in get_tokenizer().tokenize(normalize_text(text), _SPLIT_MODE):
        pos = morpheme.part_of_speech()
        if pos[0] not in allowed_pos or set(pos[1:4]).intersection(EXCLUDED_SUBPOS):
            continue
        term = _EDGE_PUNCT.sub("", morpheme.normalized_form().strip())
        if is_meaningful_term(term):
            terms.append(term)
    return terms


def extract_content_terms(text):
    """Content lemmas used for the sparse vector and for shared-keyword matching."""
    return _lemmas(text, ALLOWED_POS)


def extract_label_terms(text):
    """Nouns only, for island headings.

    Verbs stay in the document vector (they carry meaning) but make poor place
    names: profile text is full of generic actions - 食べる, 行く, 流す, 目指す -
    that outrank the actual topic on frequency. Two real builds produced islands
    called 食べる / 行く and 流す / 汗 whose contents were 家族の料理 and サウナ.
    Nouns carry the topic, so headings are built from nouns alone.

    This affects ONLY the label; coordinates come from extract_content_terms.
    """
    return _lemmas(text, {"名詞"})


def make_label_candidates(terms):
    candidates = list(dict.fromkeys(terms))
    for left, right in zip(terms, terms[1:]):
        if left != right:
            candidates.append(f"{left} {right}")
    return list(dict.fromkeys(candidates))


def display_term(term):
    return term.replace(" ", "")


def build_sparse_features(texts, fit=True, artifacts=None):
    token_lists = [extract_content_terms(text) for text in texts]
    token_docs = [" ".join(terms) for terms in token_lists]
    raw_docs = [normalize_text(text) for text in texts]

    if fit:
        word_vectorizer = TfidfVectorizer(
            tokenizer=str.split,
            preprocessor=None,
            token_pattern=None,
            lowercase=False,
            ngram_range=(1, 2),
            min_df=FEATURE_CONFIG["word_min_df"],
            max_df=0.85,
            sublinear_tf=True,
            max_features=FEATURE_CONFIG["word_max_features"],
        )
        char_vectorizer = TfidfVectorizer(
            analyzer="char",
            ngram_range=(2, 4),
            min_df=FEATURE_CONFIG["char_min_df"],
            max_df=0.95,
            sublinear_tf=True,
            max_features=FEATURE_CONFIG["char_max_features"],
        )
        word_matrix = word_vectorizer.fit_transform(token_docs)
        char_matrix = char_vectorizer.fit_transform(raw_docs)
        combined = sp.hstack([word_matrix, char_matrix * CHAR_WEIGHT], format="csr")
        n_components = min(FEATURE_CONFIG["svd_components"], max(2, combined.shape[1] - 1))
        sparse_projector = TruncatedSVD(n_components=n_components, random_state=42)
        projected = sparse_projector.fit_transform(combined)
        artifacts = {
            "word_vectorizer": word_vectorizer,
            "char_vectorizer": char_vectorizer,
            "sparse_projector": sparse_projector,
        }
    else:
        word_matrix = artifacts["word_vectorizer"].transform(token_docs)
        char_matrix = artifacts["char_vectorizer"].transform(raw_docs)
        combined = sp.hstack([word_matrix, char_matrix * CHAR_WEIGHT], format="csr")
        projected = artifacts["sparse_projector"].transform(combined)

    zero_rows = int(np.sum(np.asarray(combined.getnnz(axis=1)) == 0))
    return normalize(projected), token_lists, zero_rows, artifacts


def build_hybrid_features(texts, model, fit_sparse=True, sparse_artifacts=None):
    """The full 448-dim representation. `fit_sparse=False` at serving time."""
    sparse_features, token_lists, zero_rows, sparse_artifacts = build_sparse_features(
        texts, fit=fit_sparse, artifacts=sparse_artifacts
    )
    raw_dense = model.encode(
        [f"passage: {normalize_text(text)}" for text in texts],
        show_progress_bar=len(texts) > 20,
        normalize_embeddings=True,
    )
    concept_docs = [
        " ".join(terms) or normalize_text(text) for terms, text in zip(token_lists, texts)
    ]
    concept_dense = model.encode(
        [f"passage: {document}" for document in concept_docs],
        show_progress_bar=len(texts) > 20,
        normalize_embeddings=True,
    )
    dense = normalize(raw_dense * DENSE_RAW_WEIGHT + concept_dense * DENSE_CONCEPT_WEIGHT)
    hybrid = normalize(np.hstack([dense * DENSE_WEIGHT, sparse_features * SPARSE_WEIGHT]))
    return hybrid, token_lists, zero_rows, sparse_artifacts
