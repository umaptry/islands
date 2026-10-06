"""かさなり / islands - API and static host.

WHAT THE SERVER STILL DOES
--------------------------
Almost nothing, on purpose. The browser reads the map, leaves comments, reacts
and marks notifications read by talking to Supabase directly, with its own JWT,
under the RLS policies in supabase/schema.sql. What is left here is the work
that cannot be done anywhere else:

  POST/PATCH /api/posts   a post's x/y/vec are the output of the frozen encoder,
                          and letting a client write them would let anyone put
                          themselves anywhere on the map
  GET /api/islands        naming a landmass needs the seed corpus IDF and the
                          Japanese tokenizer
  GET /api/neighbors      turning a cosine into 似てる度 needs the anchors
  GET /api/config         what the browser needs to draw the same ground
  PUT /api/account/me     the four profile fields are embedded here, and the
                          vectors never leave the server
  GET /api/connections    one line per pair of people, from every interaction
  GET /api/similar-people needs the hidden profile vectors
  GET /api/changes        islands that remember: merges, splits, renames, tiers

Everything at request time is a pure forward pass through frozen artifacts.
Nothing here fits a vectorizer, retrains an encoder, or recomputes a layout, so
posting can never move anybody who already posted.

The /api/local/* block at the bottom is a stand-in for Supabase, active only
when there is no Supabase project configured. It is what makes `uvicorn app:app`
work with nothing else running.
"""

import hashlib
import io
import json
import logging
import os
import pickle
import re
import secrets
import threading
import time
import uuid
from collections import Counter, defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from core import affinity as people
from core import auth
from core import connections as lines
from core import growth
from core import introductions
from core import island_tracking
from core import notifications as notices
from core.clustering import assign_cluster, name_group
from core.config import (
    AWAY_DIGEST_COUNT,
    CONNECTION_CACHE_SECONDS,
    CONNECTIONS_SINCE,
    DIGEST_CONTRIBUTORS,
    ISLAND_COLORS,
    ISLAND_NOTIFY_PER_DAY,
    ISLAND_RUN_MIN_SECONDS,
    LANDMARK_CANDIDATES,
    MAP_MAX,
    MAP_MIN,
    MAP_POST_LIMIT,
    MAX_AFFILIATION_LENGTH,
    MAX_BIO_LENGTH,
    MAX_COMMENT_LENGTH,
    MAX_LINK_LENGTH,
    MAX_NAME_LENGTH,
    MAX_TEXT_LENGTH,
    MIN_TEXT_LENGTH,
    GEMINI_MODEL_NAME,
    MOTIVATION_DEFAULT,
    MOTIVATION_MAX,
    MOTIVATION_MIN,
    NOTIFICATION_CATEGORIES,
    ORBIT_NEIGHBOR_COUNT,
    PERSON_CARD_CONNECTIONS,
    PROFILE_TEXT_FIELDS,
    PROFILE_TEXT_LENGTH,
    PROFILE_TOPIC_LENGTH,
    PROFILE_TOPIC_MAX,
    SIMILAR_NOTIFY_PER_DAY,
    SIMILAR_NOTIFY_THRESHOLD,
    SIMILAR_PEOPLE_COUNT,
    TAGS,
)
from core.encoder import load_encoder
from core.energy import constants as energy_constants
from core.energy import name_landmasses
from core.features import build_hybrid_features, extract_label_terms, normalize_text
from core.geometry import scale_projected_coordinate
from core.similarity import (
    cosine_percent,
    describe_relation,
    resolve_scale,
    shared_keywords,
    similarity_view,
)
from core.store import StoreError, create_store

ROOT = Path(__file__).resolve().parent
ARTIFACTS = Path(os.environ.get("MAP_ARTIFACTS_DIR") or str(ROOT / "artifacts"))
WEB = ROOT / "web"


def _int_env(name, default):
    try:
        return max(1, int(os.environ.get(name, "").strip() or default))
    except ValueError:
        return default


# Rate limiting is per ACCOUNT, not per IP.
#
# The old per-IP limit was the single worst thing about running this in a room:
# a venue wifi puts everybody behind one public address, so the fourth person to
# sign up was turned away by a rule aimed at a scraper. Posting requires an
# account now, and an account is a much better thing to count than an address.
RATE_LIMIT_WINDOW = _int_env("KOTOBA_RATE_LIMIT_WINDOW", 300)  # seconds
RATE_LIMIT_MAX = _int_env("KOTOBA_RATE_LIMIT_MAX", 10)
RATE_LIMIT_OFF = os.environ.get("KOTOBA_DISABLE_RATE_LIMIT") == "1"
NEIGHBOR_COUNT = 3
ISLAND_CACHE_SECONDS = 60
# Naming reads this many of the most energetic live posts. Past it the tail
# contributes puddles that cannot carry a name anyway.
NAMING_POST_LIMIT = 5000
# Island tracking starts itself from /api/islands and /api/changes. The test
# suite turns that off and calls track_islands() directly, so no background
# thread is still writing when a test swaps the store.
ISLAND_AUTO_TRACK = os.environ.get("ISLANDS_AUTO_TRACK", "1") == "1"

_logger = logging.getLogger(__name__)

_URL = re.compile(r"https?://\S+|www\.\S+", re.IGNORECASE)
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")

state = {}
_rate_log = defaultdict(deque)
_rate_lock = threading.Lock()

# Landmass names are derived from the posts that are on the map right now, so
# they change whenever the map changes and stay put whenever it does not.
# Recomputing costs one query plus a union-find, so it happens on a timer rather
# than on every request.
_islands_cache = {"stamp": 0.0, "value": [], "key": None}
_islands_lock = threading.Lock()

# Lines between people. In a deployment the browser writes reactions and
# comments straight to Supabase, so the server cannot know when a line changes;
# it re-reads at most every CONNECTION_CACHE_SECONDS instead.
_connections_cache = {"stamp": 0.0, "value": None}
_connections_lock = threading.Lock()
# Held while one tracking step runs in this process. The database claim
# (claim_island_run) is what keeps two instances apart.
_island_run_lock = threading.Lock()


# --------------------------------------------------------------------------
# startup
# --------------------------------------------------------------------------

def load_artifacts():
    """Load the frozen map. Missing artifacts is a hard failure, not a warning."""
    from core.artifact_manifest import validate_manifest
    manifest = validate_manifest(ARTIFACTS, os.environ.get("EMBEDDING_PROVIDER", "onnx"))
    seed_map_path = ARTIFACTS / "seed_map.json"
    if not seed_map_path.exists():
        raise RuntimeError(
            f"{seed_map_path} がありません。先に python scripts/build_seed_map.py を実行してください。"
        )
    with io.open(seed_map_path, encoding="utf-8") as handle:
        seed_map = json.load(handle)

    encoder, scale_bounds = load_encoder(ARTIFACTS / "encoder.npz")
    if scale_bounds != seed_map["scale_bounds"]:
        raise RuntimeError("encoder.npz と seed_map.json の scale_bounds が一致しません。")

    with io.open(ARTIFACTS / "vectorizers.pkl", "rb") as handle:
        sparse_artifacts = pickle.load(handle)

    seed = np.array(seed_map["seed"], dtype=float)
    # The client frames the camera on the corpus but never draws it, so it needs
    # the extent and not the 1,000 points.
    seed_bounds = [
        float(seed[:, 0].min()), float(seed[:, 1].min()),
        float(seed[:, 0].max()), float(seed[:, 1].max()),
    ]
    return {
        "seed_map": seed_map,
        "manifest": manifest,
        "seed_bounds": seed_bounds,
        "encoder": encoder,
        "scale_bounds": scale_bounds,
        "sparse_artifacts": sparse_artifacts,
        "seed_coords": seed[:, :2],
        "seed_clusters": seed[:, 2].astype(int),
        "islands": seed_map["islands"],
        "quantiles": seed_map["distance_quantiles"],
        # Resolved once, here, rather than at each call site. None means the
        # ruler and the space disagree, and every similarity path degrades to
        # something that at least measures itself.
        **dict(zip(
            ("cosine_anchors", "cosine_centroid"),
            resolve_scale(seed_map.get("cosine_anchors"), seed_map.get("cosine_centroid")),
        )),
        "idf": seed_map["idf"],
    }


@asynccontextmanager
async def lifespan(_app):
    from core.embedder import load_embedder

    print("artifacts を読み込み中...", flush=True)
    state.update(load_artifacts())
    _gemini = os.environ.get("EMBEDDING_PROVIDER", "onnx") == "gemini"
    _label = f"Gemini API ({GEMINI_MODEL_NAME})" if _gemini else "ONNX (multilingual-e5-small)"
    print(f"埋め込みモデルを読み込み中: {_label}", flush=True)
    state["model"] = load_embedder()
    state["store"] = create_store()
    if _gemini:
        from core.embedding_cache import CachedEmbedder, SQLiteEmbeddingCache
        cache = state["store"] if state["store"].backend == "supabase" else SQLiteEmbeddingCache(
            os.environ.get("EMBEDDING_CACHE_PATH", str(ROOT / ".cache" / "embeddings.sqlite3")))
        state["model"] = CachedEmbedder(state["model"], cache, state["manifest"]["embedding"])
    state["local_mode"] = state["store"].backend == "memory"
    if _gemini and not state["local_mode"] and os.environ.get("MAP_RUNTIME_CHECK") != "1":
        raise RuntimeError("Production Gemini requires MAP_RUNTIME_CHECK=1 and the model-runtime migration")
    state["images"] = {}
    state["otp"] = {}

    if state["local_mode"]:
        # Easy to miss otherwise: the app works perfectly, and then a restart
        # silently erases everyone who signed up.
        rule = "!" * 70
        for line in (
            "",
            rule,
            "[警告] SUPABASE_URL / SUPABASE_SERVICE_KEY が未設定です。",
            "       ローカルモードで起動します。アカウントも投稿もメモリ上にのみ保存され、",
            "       再起動で全て消えます。ログインのパスコードは画面に表示されます。",
            "       ローカル開発では正常です。公開環境なら Secret を設定してください。",
            rule,
            "",
        ):
            print(line, flush=True)
    elif not auth.configured():
        raise RuntimeError(
            "SUPABASE_URL は設定されていますが JWT を検証できません。"
            "SUPABASE_JWT_SECRET を設定するか、プロジェクトの JWKS が引けることを確認してください。"
        )

    limit = "無効" if RATE_LIMIT_OFF else f"{RATE_LIMIT_MAX}回/{RATE_LIMIT_WINDOW}秒"
    print(
        f"準備完了: seed={len(state['seed_coords'])}点 / "
        f"領域={len(state['islands'])} / store={state['store'].backend} / "
        f"投稿制限={limit}",
        flush=True,
    )
    yield


app = FastAPI(title="islands", lifespan=lifespan, docs_url=None, redoc_url=None)

# The free egress allowance on the deploy target is 1GiB/month, and the web
# assets are highly compressible text. minimum_size skips the small JSON
# replies, where the header would cost more than the compression saves.
app.add_middleware(GZipMiddleware, minimum_size=1024)


def runtime_status():
    if state.get("local_mode") or os.environ.get("MAP_RUNTIME_CHECK", "0") != "1":
        return {"maintenance": False, "active_version": state["manifest"]["artifact_version"]}
    return state["store"].runtime_status()


@app.middleware("http")
async def map_runtime_guard(request, call_next):
    protected = request.url.path.startswith('/api/') and request.url.path not in ('/api/health', '/api/config')
    if protected and state.get("manifest"):
        from starlette.concurrency import run_in_threadpool
        try:
            runtime = await run_in_threadpool(runtime_status)
        except StoreError:
            return JSONResponse({"detail": "現在、稼働状態を確認できません。"}, status_code=503)
        writes = request.method not in ("GET", "HEAD", "OPTIONS")
        if (runtime["maintenance"] and writes) or runtime["active_version"] != state["manifest"]["artifact_version"]:
            return JSONResponse({"detail": "地図を更新しています。しばらくしてから再読み込みしてください。"}, status_code=503,
                                headers={"Retry-After": "30"})
    return await call_next(request)


# --------------------------------------------------------------------------
# request models
# --------------------------------------------------------------------------

class PostCreate(BaseModel):
    body: str = Field(min_length=1)
    tags: list[str] = Field(default_factory=list)
    motivation: int = MOTIVATION_DEFAULT
    image_path: str | None = None


class PostPatch(BaseModel):
    body: str | None = None
    tags: list[str] | None = None
    motivation: int | None = None
    image_path: str | None = None
    # Explicit rather than a DELETE-only path: islands' card menu offers edit
    # and delete from the same place, and both are the author changing their
    # own row.
    clear_image: bool = False


class AccountPatch(BaseModel):
    display_name: str | None = None
    affiliation: str | None = None
    bio: str | None = None
    link_url: str | None = None
    icon_id: str | None = None
    avatar_path: str | None = None
    # The people layer. Only this server writes them: each is embedded on save
    # and the vectors are what 似ている人 compares.
    topics: list[str] | None = None
    goal: str | None = None
    seeking: str | None = None
    offering: str | None = None


class NotificationSetting(BaseModel):
    category: str
    push: bool
    in_app: bool


class NotificationSettings(BaseModel):
    settings: list[NotificationSetting]


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def current_user(request):
    """The account id behind this request, or 401."""
    try:
        user_id, _claims = auth.identify(request)
    except auth.AuthError:
        raise HTTPException(status_code=401, detail="ログインしてください。")
    return user_id


def optional_user(request):
    """The account id behind this request, or None when nobody is signed in."""
    try:
        user_id, _claims = auth.identify(request)
    except auth.AuthError:
        return None
    return user_id


def check_rate_limit(key):
    if RATE_LIMIT_OFF:
        return True
    now = time.time()
    with _rate_lock:
        log = _rate_log[key]
        while log and now - log[0] > RATE_LIMIT_WINDOW:
            log.popleft()
        if len(log) >= RATE_LIMIT_MAX:
            return False
        log.append(now)
    return True


def sanitize(text):
    """Strip contact details. People paste them without thinking, and the map is public."""
    text = _URL.sub("[リンク]", text)
    return _EMAIL.sub("[メール]", text)


def clean_tags(tags):
    """Only the four islands tags, de-duplicated, in the canonical order.

    Order matters because the badges are rendered in list order and two people
    who picked the same two tags should see them the same way round.
    """
    chosen = {tag for tag in (tags or []) if tag in TAGS}
    return [tag for tag in TAGS if tag in chosen]


def clean_motivation(value):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return MOTIVATION_DEFAULT
    return max(MOTIVATION_MIN, min(MOTIVATION_MAX, number))


def clean_body(raw):
    text = sanitize(normalize_text(raw or ""))[:MAX_TEXT_LENGTH]
    if len(text) < MIN_TEXT_LENGTH:
        raise HTTPException(
            status_code=422,
            detail=("本文を書いてください。" if MIN_TEXT_LENGTH <= 1
                    else f"本文は{MIN_TEXT_LENGTH}字以上でお願いします（現在{len(text)}字）。"),
        )
    return text


def project(text):
    """text -> (x, y, cluster_id, terms, vector, centred_vector).

    The only place text becomes position.

    Note the two different term sets. The 448-dim vector is built from nouns,
    verbs AND adjectives, because verbs carry meaning. The `terms` stored are
    NOUNS ONLY, because they exist to be shown back to a reader as shared-word
    chips and to name a landmass, and a name led by 揃える reads worse than one
    led by 焚き火.
    """
    from core.embedder import EmbeddingUnavailable
    try:
        features, _token_lists, zero_rows, _ = build_hybrid_features(
            [text], state["model"], fit_sparse=False, sparse_artifacts=state["sparse_artifacts"]
        )
    except (EmbeddingUnavailable, StoreError):
        raise HTTPException(status_code=503, detail="文章の配置を完了できませんでした。時間をおいて再試行してください。", headers={"Retry-After": "15"})
    if zero_rows:
        raise HTTPException(
            status_code=422,
            detail="意味のある単語が見つかりませんでした。もう少し具体的に書いてみてください。",
        )
    vector = features[0]
    raw = state["encoder"](vector)
    x, y = scale_projected_coordinate(float(raw[0]), float(raw[1]), state["scale_bounds"])
    cluster_id = assign_cluster(x, y, state["seed_coords"], state["seed_clusters"])

    # The vector similarity is measured in. Storing it lets Postgres rank
    # neighbours with an HNSW index instead of the server pulling every vector
    # out of the database and scoring them in numpy - which is the difference
    # between O(log n) and O(n) on the one query people make constantly.
    centred = similarity_view(vector, state.get("cosine_centroid"))
    if centred is None:
        centred = vector
    return (
        round(x, 2), round(y, 2), int(cluster_id), extract_label_terms(text),
        vector, np.asarray(centred, dtype=float),
    )


def as_pgvector(values):
    """pgvector accepts its literal text form over PostgREST."""
    return "[" + ",".join(f"{float(value):.6f}" for value in values) + "]"


def live_islands(force=False):
    """Landmasses, named by the people standing on them.

    islands decided a post's genre by matching its text against a table of
    twelve hand-written keyword lists. That was the best it could do with random
    coordinates. Here the coordinates carry meaning, so the name comes from the
    words of the posts on the landmass, ranked by how many people used them and
    how rare they are in the seed corpus. A landmass with nothing nameable on it
    gets no name and is not drawn with one: the map starts as open water and
    grows names as people arrive.
    """
    now = time.time()
    with _islands_lock:
        fresh = now - _islands_cache["stamp"] < ISLAND_CACHE_SECONDS
        if fresh and not force and _islands_cache["key"] is not None:
            return _islands_cache["value"]

    try:
        posts = state["store"].list_terms(limit=NAMING_POST_LIMIT)
    except StoreError:
        # Keep whatever was last computed rather than blanking every label.
        with _islands_lock:
            return _islands_cache["value"]

    if len(posts) >= NAMING_POST_LIMIT:
        _logger.warning("island naming capped at %d posts; some posts will have no island membership", NAMING_POST_LIMIT)

    named = name_landmasses(posts, state["idf"], name_group)
    # Explicit membership replaces the client's former centre-distance guess.
    payload = named
    membership = {}
    for index, island in enumerate(named):
        for post_id in island["post_ids"]:
            membership[post_id] = index

    with _islands_lock:
        _islands_cache.update({"stamp": now, "value": payload, "key": membership})
    return payload


def island_of(post_id):
    """The landmass a post is standing on, as it is named right now."""
    live_islands()
    with _islands_lock:
        membership = _islands_cache["key"] or {}
        islands = _islands_cache["value"]
    index = membership.get(post_id)
    return islands[index] if index is not None and index < len(islands) else None


def invalidate_islands():
    with _islands_lock:
        _islands_cache["stamp"] = 0.0


# --------------------------------------------------------------------------
# people layer: lines, similar people, islands that remember
# --------------------------------------------------------------------------

def clean_topics(values):
    """At most PROFILE_TOPIC_MAX distinct words, each 1..PROFILE_TOPIC_LENGTH long."""
    out, seen = [], set()
    for value in values or []:
        word = sanitize(" ".join(str(value).split()))[:PROFILE_TOPIC_LENGTH].strip()
        key = people.normalise_topic(word)
        if not word or key in seen:
            continue
        seen.add(key)
        out.append(word)
        if len(out) >= PROFILE_TOPIC_MAX:
            break
    return out


def clean_profile_text(value):
    """One sentence: whitespace folded, contact details hidden, capped. Empty is None."""
    if value is None:
        return None
    return sanitize(" ".join(str(value).split()))[:PROFILE_TEXT_LENGTH].strip() or None


def dense_mean():
    """The seed corpus mean that profile vectors are centred on, or None."""
    return (state.get("cosine_centroid") or {}).get("dense_mean")


def people_index():
    """Everybody's profile fields, hidden vectors and post centroid, by id."""
    store = state["store"]
    centroids = store.post_centroids()
    index = {}
    for row in store.profile_vectors():
        row["centroid"] = (centroids.get(row["id"]) or {}).get("centroid")
        index[row["id"]] = row
    return index


def similar_people(account_id, limit=SIMILAR_PEOPLE_COUNT, index=None):
    index = index if index is not None else people_index()
    me = index.get(account_id)
    if me is None:
        return []
    return people.rank_similar(
        me, list(index.values()), limit=limit,
        dense_mean=dense_mean(), post_anchors=state.get("cosine_anchors"),
    )


def notify_similar(account_id):
    """Tell the people a newly filled profile is close to.

    Once per pair, ever, and at most SIMILAR_NOTIFY_PER_DAY a day for each
    person told. The rows are written whatever the settings say: settings only
    decide whether a row interrupts (push, badge), never whether it exists.
    """
    store = state["store"]
    day_ago = datetime.now(timezone.utc) - timedelta(days=1)
    rows = []
    for match in similar_people(account_id, limit=50):
        if match["score"] < SIMILAR_NOTIFY_THRESHOLD:
            break
        earlier = store.recent_notifications("similar", None, recipient_id=match["id"])
        if any(row.get("actor_id") == account_id for row in earlier):
            continue
        today = [row for row in earlier if notices.parse_time(row["created_at"]) >= day_ago]
        if len(today) >= SIMILAR_NOTIFY_PER_DAY:
            continue
        rows.append({
            "recipient_id": match["id"], "actor_id": account_id, "type": "similar",
            "payload": {"score": match["score"], "shared_topics": match["shared_topics"]},
        })
    store.insert_notifications(rows)
    return rows


def home_posts(posts=None):
    """(post id -> {x, y}, author -> their most energetic live post)."""
    where, best = {}, {}
    if posts is None:
        posts = state["store"].list_terms(limit=NAMING_POST_LIMIT)
    for post in posts:
        if post.get("x") is None or post.get("y") is None:
            continue
        where[post["id"]] = {"x": float(post["x"]), "y": float(post["y"])}
        author = post.get("author_id")
        energy = float(post.get("energy") or 0.0)
        if author and (author not in best or energy > best[author]["energy"]):
            best[author] = {"id": post["id"], "energy": energy, **where[post["id"]]}
    return where, best


def islands_by_author(posts=None):
    """author -> labels of the islands their posts stand on, most posts first."""
    if posts is None:
        posts = state["store"].list_terms(limit=NAMING_POST_LIMIT)
    author_of = {post["id"]: post.get("author_id") for post in posts}
    counts = defaultdict(Counter)
    for island in live_islands():
        for post_id in island.get("post_ids") or []:
            author = author_of.get(post_id)
            if author:
                counts[author][island.get("label") or island.get("name")] += 1
    return {author: [label for label, _ in counter.most_common()] for author, counter in counts.items()}


def introduce(viewer_id, other_id, index, places, ranked=None):
    """Why `viewer_id` might want to meet `other_id`, and a first line to say.

    index: people_index(); places: islands_by_author(); ranked: the
    affinity() row already worked out for this pair, if there is one.
    """
    me, other = index.get(viewer_id), index.get(other_id)
    if me is None or other is None:
        return {"reasons": [], "opener": introductions.opener([], {})}
    if ranked is None:
        ranked = people.affinity(me, other, dense_mean=dense_mean(),
                                 post_anchors=state.get("cosine_anchors")) or {}
    seeking, offering = people.directions(me, other, dense_mean=dense_mean())
    mine = places.get(viewer_id) or []
    shared_islands = [label for label in places.get(other_id) or [] if label in mine]
    shared_topics = ranked.get("shared_topics") or []
    found = introductions.reasons(
        me, other, ranked.get("parts") or {}, seeking=seeking, offering=offering,
        shared_islands=shared_islands, shared_topics=shared_topics,
    )
    return {"reasons": found, "opener": introductions.opener(found, other, shared_topics)}


def connection_lines(force=False):
    """Every line between two people, strongest first (cached briefly)."""
    now = time.time()
    with _connections_lock:
        cached = _connections_cache["value"]
        if cached is not None and not force and now - _connections_cache["stamp"] < CONNECTION_CACHE_SECONDS:
            return cached
    store = state["store"]
    events = store.interaction_events(since=CONNECTIONS_SINCE)
    # A line ends on each person's most-touched post; somebody whose posts the
    # other never touched is drawn from their most energetic one.
    where, best = home_posts()
    value = lines.build(events, fallback_posts={author: post["id"] for author, post in best.items()})
    # The map draws a line from these alone: where both ends stand, and who the
    # two are for the tap on a boat. Posts the map has not loaded yet still
    # have a place, so a line does not wait for the viewport to reach it.
    names = {row["id"]: row for row in store.list_accounts(sorted({p for row in value for p in (row["a"], row["b"])}))}
    for row in value:
        for side in ("a", "b"):
            spot = where.get(row[f"{side}_post"])
            person = names.get(row[side]) or {}
            row[f"{side}_at"] = [spot["x"], spot["y"]] if spot else None
            row[f"{side}_name"] = person.get("display_name", "")
            row[f"{side}_icon"] = person.get("icon_id", "0")
    with _connections_lock:
        _connections_cache.update({"stamp": now, "value": value})
    return value


def invalidate_connections():
    with _connections_lock:
        _connections_cache["stamp"] = 0.0


def landmark_ranker(islands, posts_by_id):
    """island -> LANDMARK_CANDIDATES ordered by closeness to the island's words.

    One encode call for every island; the candidates are encoded once per
    process. Both sides are centred on the seed mean, as profiles are.
    """
    model = state["model"]
    texts = []
    for island in islands:
        counts = Counter()
        for post_id in island.get("post_ids") or []:
            counts.update(set((posts_by_id.get(post_id) or {}).get("terms") or []))
        words = [island.get("name") or ""] + [word for word, _ in counts.most_common(8)]
        texts.append("、".join(word for word in words if word) or "島")
    if not texts:
        return None
    if state.get("landmark_vectors") is None:
        state["landmark_vectors"] = np.asarray(
            model.encode(list(LANDMARK_CANDIDATES), normalize_embeddings=True), dtype=float)
    mean = dense_mean()

    def unit(vector):
        vector = np.asarray(people.centre(vector, mean), dtype=float)
        norm = float(np.linalg.norm(vector))
        return vector / norm if norm else vector

    candidates = np.array([unit(row) for row in state["landmark_vectors"]])
    ranked = {}
    for island, vector in zip(islands, np.asarray(model.encode(texts, normalize_embeddings=True), dtype=float)):
        scores = candidates @ unit(vector)
        order = sorted(range(len(LANDMARK_CANDIDATES)), key=lambda k: (-float(scores[k]), k))
        ranked[id(island)] = [LANDMARK_CANDIDATES[k] for k in order]
    return lambda island: ranked.get(id(island))


# Changes worth interrupting the people on the island for. Going quiet is in
# the log but tells nobody.
ISLAND_NOTIFY_KINDS = ("birth", "merge", "split", "rename", "tier", "landmark")


def notify_islands(events, states, now):
    """One 'island' notification per person per island per day at most."""
    store = state["store"]
    authors = {row["id"]: row.get("author_ids") or [] for row in states if row.get("active", True)}
    sent = Counter(
        (row["recipient_id"], row.get("island_id"))
        for row in store.recent_notifications("island", now - timedelta(days=1))
    )
    rows = []
    for event in events:
        if event["kind"] not in ISLAND_NOTIFY_KINDS:
            continue
        for person in authors.get(event["island_id"], []):
            key = (person, event["island_id"])
            if sent[key] >= ISLAND_NOTIFY_PER_DAY:
                continue
            sent[key] += 1
            name = (event.get("after") or {}).get("name") or (event.get("before") or {}).get("name")
            rows.append({
                "recipient_id": person, "actor_id": None, "type": "island",
                "island_id": event["island_id"], "event_id": event["id"],
                "payload": {"kind": event["kind"], "cause": event["cause"], "name": name},
            })
    store.insert_notifications(rows)
    return rows


def track_islands(now=None):
    """One tracking step: match the live islands to the stored ones, save, notify.

    The first step ever records every island as born but tells nobody: those
    islands were there before anybody was watching.
    """
    store = state["store"]
    now = now or datetime.now(timezone.utc)
    named = live_islands(force=True)
    posts_by_id = {post["id"]: post for post in store.list_terms(limit=NAMING_POST_LIMIT)}
    events = store.interaction_events(since=None)
    previous = store.island_states()
    try:
        ranker = landmark_ranker(named, posts_by_id)
    except Exception:  # an embedding outage costs the landmarks, not the step
        _logger.exception("landmark ranking failed")
        ranker = None
    result = island_tracking.update(previous, named, posts_by_id, events, now=now, rank_landmarks=ranker)
    store.save_island_states(result["states"])
    store.add_island_events(result["events"])
    result["notifications"] = notify_islands(result["events"], result["states"], now) if previous else []
    return result


def maybe_track_islands():
    """Start a tracking step in the background if this caller wins the claim."""
    if not ISLAND_AUTO_TRACK or not _island_run_lock.acquire(blocking=False):
        return False
    try:
        claimed = state["store"].claim_island_run(ISLAND_RUN_MIN_SECONDS)
    except StoreError:
        claimed = False
    if not claimed:
        _island_run_lock.release()
        return False

    def work():
        try:
            track_islands()
        except Exception:
            _logger.exception("island tracking failed")
        finally:
            _island_run_lock.release()

    threading.Thread(target=work, name="island-tracking", daemon=True).start()
    return True


def with_tracked_state(payload):
    """Live islands with the id, tier and landmarks of the island they continue."""
    try:
        states = state["store"].island_states()
    except StoreError:
        return payload
    _links, identity = island_tracking.match(states, payload)
    out = []
    for index, island in enumerate(payload):
        row = dict(island)
        known = states[identity[index]] if index in identity else None
        if known:
            row.update({
                "island_id": known["id"],
                "tier": known.get("tier", 0),
                "tier_name": growth.tier_name(known.get("tier", 0)),
                "score": known.get("score_shown"),
                "landmarks": [item["name"] for item in known.get("landmarks") or []],
                "quiet": bool(known.get("quiet")),
            })
        out.append(row)
    return out


# Which changes count as big for somebody with no stake in the island.
_DIGEST_WEIGHT = {"merge": 3, "split": 3, "birth": 2, "tier": 2, "rename": 1, "landmark": 1, "quiet": 0}


def similarity_of(cosine):
    """A cosine as 似てる度, or None when this build cannot say."""
    anchors = state.get("cosine_anchors")
    if anchors is None or cosine is None:
        return None
    return cosine_percent(cosine, anchors)


def neighbors_for(post_id, terms, limit):
    """Ranked neighbours with shared words, straight off the ANN index.

    Ranking is by the 448-dim cosine and never by distance on the map. The map
    is a 2-D shadow of that space and this build's own gate records that only
    34% of true neighbours survive the projection.
    """
    store = state["store"]
    try:
        ranked = store.nearest_posts(post_id, limit)
    except StoreError:
        return []
    out = []
    for other_id, cosine in ranked:
        try:
            other = store.get_post(other_id)
        except StoreError:
            continue
        if not other:
            continue
        try:
            account = store.get_account(other["author_id"]) or {}
        except StoreError:
            account = {}
        shared = shared_keywords(terms, other.get("terms") or [], state["idf"])
        similarity = similarity_of(cosine)
        out.append({
            "id": other["id"],
            "author_id": other["author_id"],
            "display_name": account.get("display_name", ""),
            "icon_id": account.get("icon_id", "0"),
            "avatar_path": account.get("avatar_path"),
            "body": other["body"],
            "tags": other.get("tags") or [],
            "motivation": other.get("motivation"),
            "x": other["x"],
            "y": other["y"],
            "cluster_id": other["cluster_id"],
            "similarity": similarity,
            "cosine": round(float(cosine), 6),
            "shared": shared,
            "note": describe_relation(similarity if similarity is not None else 0, shared),
        })
    return out


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------

@app.get("/api/config")
def config():
    """Everything the browser needs before it can draw anything.

    The energy constants are served rather than duplicated in JavaScript. They
    are islands' numbers, and the terrain the server names has to be the terrain
    the browser paints; two copies of `(30 + e * 0.45) * (2/3)` would agree right
    up until somebody changed one.
    """
    anchors = state.get("cosine_anchors") or {}
    return {
        "mode": "local" if state["local_mode"] else "supabase",
        "map_version": state["manifest"]["artifact_version"],
        "supabase": {
            "url": os.environ.get("SUPABASE_URL", "").strip(),
            "anon_key": os.environ.get("SUPABASE_ANON_KEY", "").strip(),
            "bucket": "post-images",
        },
        "oauth": [
            name for name, flag in (
                ("google", os.environ.get("KOTOBA_OAUTH_GOOGLE") == "1"),
                ("apple", os.environ.get("KOTOBA_OAUTH_APPLE") == "1"),
            ) if flag
        ],
        "world": {"min": MAP_MIN, "max": MAP_MAX, "seed_bounds": state["seed_bounds"]},
        "energy": energy_constants(),
        "tags": list(TAGS),
        "island_colors": list(ISLAND_COLORS),
        "limits": {
            "body_min": MIN_TEXT_LENGTH,
            "body_max": MAX_TEXT_LENGTH,
            "name_max": MAX_NAME_LENGTH,
            "comment_max": MAX_COMMENT_LENGTH,
            "bio_max": MAX_BIO_LENGTH,
            "link_max": MAX_LINK_LENGTH,
            "motivation_default": MOTIVATION_DEFAULT,
            "map_post_limit": MAP_POST_LIMIT,
            "orbit_neighbors": ORBIT_NEIGHBOR_COUNT,
            "image_bytes": 1_048_576,
        },
        "similarity": {
            "measured_in": "448d-cosine" if state.get("cosine_anchors") else "map-distance",
            "floor": anchors.get("cosine_floor"),
            "ceiling": anchors.get("cosine_ceiling"),
        },
    }


@app.get("/api/health")
def health():
    # The keep-alive ping hits this route, and a Supabase free project suspends
    # itself after 7 idle days. Touching the database keeps both halves of the
    # deployment awake with one request. A store that is down must not take
    # health down with it - the answer is still useful without the count.
    try:
        posts = state["store"].count_posts()
        store_ok = True
    except StoreError:
        posts = None
        store_ok = False
    try:
        runtime = runtime_status()
        compatible = runtime['active_version'] == state['manifest']['artifact_version']
    except StoreError:
        runtime = {"maintenance": True, "active_version": None}
        compatible = False
    return {
        "ok": True,
        "seed_count": len(state["seed_coords"]),
        "regions": len(state["islands"]),
        "store": state["store"].backend,
        "store_ok": store_ok,
        "posts": posts,
        "model_version": state["seed_map"]["meta"]["model_version"],
        "embedding": state["manifest"]["embedding"],
        "artifact_version": state["manifest"]["artifact_version"],
        "artifact_compatible": compatible,
        "maintenance": runtime["maintenance"],
        "active_map_version": runtime["active_version"],
        "ready": store_ok and compatible and not runtime["maintenance"],
    }


@app.get("/api/islands")
def islands(response: Response):
    maybe_track_islands()
    payload = with_tracked_state(live_islands())
    # Everyone looking at the map wants the same answer, and it changes on a
    # timer rather than per viewer. Worth a CDN hop if one is ever put in front.
    response.headers["Cache-Control"] = "public, max-age=30"
    return {"islands": payload}


@app.get("/api/connections")
def connections(response: Response, person: str = ""):
    """Lines between people. Public: a line is visible to everybody, not just the two."""
    try:
        rows = connection_lines()
    except StoreError:
        raise HTTPException(status_code=503, detail="読み込みに失敗しました。")
    if person:
        rows = [row for row in rows if person in (row["a"], row["b"])]
    response.headers["Cache-Control"] = f"public, max-age={CONNECTION_CACHE_SECONDS}"
    return {"connections": rows, "since": CONNECTIONS_SINCE}


@app.get("/api/similar-people")
def similar_people_route(request: Request, account: str = ""):
    """The people most like `account` (or the signed-in person), best first."""
    account = account or current_user(request)
    store = state["store"]
    try:
        index = people_index()
        ranked = similar_people(account, index=index)
        # Where each of them stands on the map: the dotted line goes there.
        posts = store.list_terms(limit=NAMING_POST_LIMIT) if ranked else []
        _, best = home_posts(posts)
        places = islands_by_author(posts) if ranked else {}
        accounts = {row["id"]: row for row in store.list_accounts([row["id"] for row in ranked])}
        out = []
        for row in ranked:
            person = accounts.get(row["id"]) or {}
            home = best.get(row["id"])
            # Q15: a suggestion is never shown without the reason for it.
            intro = introduce(account, row["id"], index, places, ranked=row)
            out.append({
                **row,
                "display_name": person.get("display_name", ""),
                "icon_id": person.get("icon_id", "0"),
                "avatar_path": person.get("avatar_path"),
                "topics": person.get("topics") or [],
                "goal": person.get("goal"),
                "island": (places.get(row["id"]) or [None])[0],
                "reasons": intro["reasons"],
                "post": {"id": home["id"], "x": home["x"], "y": home["y"]} if home else None,
            })
    except StoreError:
        raise HTTPException(status_code=503, detail="読み込みに失敗しました。")
    return {"people": out}


@app.get("/api/people/{person_id}/card")
def person_card(person_id: str, request: Request, viewer: str = ""):
    """One person, as the map's person card shows them.

    Who they are, their latest post, up to PERSON_CARD_CONNECTIONS of the
    people they have a line with, and - when somebody is looking (signed in,
    or `viewer`, the same public question /api/similar-people answers) - what
    the two have in common and a first line to say.
    """
    viewer = optional_user(request) or viewer or None
    store = state["store"]
    try:
        person = store.get_account(person_id)
        if not person:
            raise HTTPException(status_code=404, detail="見つかりませんでした。")
        own = store.posts_by_author(person_id)
        places = islands_by_author()
        rows = [row for row in connection_lines() if person_id in (row["a"], row["b"])]
        partner_ids = [row["b"] if row["a"] == person_id else row["a"] for row in rows]
        shown = partner_ids[:PERSON_CARD_CONNECTIONS]
        partners = {row["id"]: row for row in store.list_accounts(shown)}
        intro = None
        if viewer and viewer != person_id:
            intro = introduce(viewer, person_id, people_index(), places)
    except StoreError:
        raise HTTPException(status_code=503, detail="読み込みに失敗しました。")

    latest = own[0] if own else None
    return {
        "person": {key: person.get(key) for key in (
            "id", "display_name", "icon_id", "avatar_path", "affiliation", "bio", "link_url",
            "topics", "goal", "seeking", "offering")},
        "island": (places.get(person_id) or [None])[0],
        "post_count": len(own),
        "latest_post": {key: latest.get(key) for key in (
            "id", "body", "x", "y", "created_at", "like_count", "comment_count")} if latest else None,
        "connections": [{
            "id": partner,
            "display_name": (partners.get(partner) or {}).get("display_name", ""),
            "icon_id": (partners.get(partner) or {}).get("icon_id", "0"),
            "avatar_path": (partners.get(partner) or {}).get("avatar_path"),
        } for partner in shown],
        "connection_count": len(rows),
        "connected": bool(viewer) and viewer in partner_ids,
        "reasons": intro["reasons"] if intro else [],
        "opener": intro["opener"] if intro else None,
    }


def _parse_since(value):
    if not value:
        return None
    try:
        return notices.parse_time(value).isoformat()
    except ValueError:
        raise HTTPException(status_code=422, detail="since は日時で指定してください。")


@app.get("/api/changes")
def changes(since: str = "", limit: int = 50):
    """What happened to the islands: place, cause and the counts before and after."""
    maybe_track_islands()
    limit = max(1, min(int(limit), 200))
    try:
        rows = state["store"].list_island_events(since=_parse_since(since), limit=limit)
    except StoreError:
        raise HTTPException(status_code=503, detail="読み込みに失敗しました。")
    return {"changes": rows}


@app.get("/api/changes/digest")
def changes_digest(request: Request):
    """While you were away: your islands first, then your people's, then big news.

    Reading it records this visit, so the next digest starts from now.
    """
    user_id = current_user(request)
    store = state["store"]
    maybe_track_islands()
    try:
        previous = store.touch_last_seen(user_id)
        start = previous or (datetime.now(timezone.utc) - timedelta(days=14)).isoformat()
        rows = store.list_island_events(since=start, limit=500)
        islands_by_id = {row["id"]: row for row in store.island_states(active_only=False)}
        friends = lines.partners(connection_lines(), user_id)
        # What led up to the changes: interactions from a while before them.
        lead_in = (notices.parse_time(start) - timedelta(days=14)).isoformat()
        events = store.interaction_events(since=lead_in)
    except StoreError:
        raise HTTPException(status_code=503, detail="読み込みに失敗しました。")

    picked = []
    for row in rows:
        authors = set((islands_by_id.get(row["island_id"]) or {}).get("author_ids") or [])
        weight = _DIGEST_WEIGHT.get(row["kind"], 0)
        if user_id in authors:
            reason, rank = "mine", 0
        elif authors & friends:
            reason, rank = "connected", 1
        elif weight >= 2:
            reason, rank = "big", 2
        else:
            continue
        picked.append((rank, -weight, row, reason))
    picked.sort(key=lambda item: (item[0], item[1], -notices.parse_time(item[2]["created_at"]).timestamp()))
    picked = picked[:AWAY_DIGEST_COUNT]

    # The people behind each change: whose likes and comments on the island's
    # posts led up to it or, with none, who posted there.
    behind = {}
    for _, _, row, _ in picked:
        island = islands_by_id.get(row["island_id"]) or {}
        found = introductions.contributors(
            island.get("post_ids"), events, before=notices.parse_time(row["created_at"]),
            exclude={user_id}, limit=DIGEST_CONTRIBUTORS,
        )
        role = "interaction"
        if not found:
            found = [person for person in island.get("author_ids") or [] if person != user_id]
            found, role = found[:DIGEST_CONTRIBUTORS], "posts"
        behind[row["id"]] = (found, role)
    try:
        names = {row["id"]: row for row in store.list_accounts(
            sorted({person for found, _ in behind.values() for person in found}))}
    except StoreError:
        names = {}

    def who(row):
        found, role = behind.get(row["id"], ([], "posts"))
        return {
            "people": [{
                "id": person,
                "display_name": names[person].get("display_name", ""),
                "icon_id": names[person].get("icon_id", "0"),
                "avatar_path": names[person].get("avatar_path"),
            } for person in found if person in names],
            "people_role": role,
        }

    return {
        "since": previous,
        "changes": [{**row, "reason": reason, **who(row)} for _, _, row, reason in picked],
    }


@app.get("/api/notification-settings")
def notification_settings(request: Request):
    """Push and in-app switches for each of the five kinds. No row means on."""
    user_id = current_user(request)
    try:
        rows = state["store"].get_notification_settings(user_id)
    except StoreError:
        raise HTTPException(status_code=503, detail="読み込みに失敗しました。")
    return {"settings": notices.merge_settings(rows), "categories": list(NOTIFICATION_CATEGORIES)}


@app.put("/api/notification-settings")
def put_notification_settings(payload: NotificationSettings, request: Request):
    user_id = current_user(request)
    rows = [item.model_dump() for item in payload.settings]
    unknown = [row["category"] for row in rows if row["category"] not in NOTIFICATION_CATEGORIES]
    if unknown:
        raise HTTPException(status_code=422, detail=f"知らない通知の種類です: {', '.join(unknown)}")
    try:
        saved = state["store"].put_notification_settings(user_id, rows)
    except StoreError:
        raise HTTPException(status_code=503, detail="保存に失敗しました。もう一度お試しください。")
    return {"settings": notices.merge_settings(saved), "categories": list(NOTIFICATION_CATEGORIES)}


@app.get("/api/map/bounds")
def map_bounds():
    from core.energy import post_radius
    try:
        posts = state["store"].terrain_posts()
    except StoreError as exc:
        raise HTTPException(503, "地図の範囲を読み込めませんでした。") from exc
    if not posts:
        return {"bounds": None, "count": 0}
    return {"bounds": [min(p["x"] - post_radius(p) for p in posts),
                       min(p["y"] - post_radius(p) for p in posts),
                       max(p["x"] + post_radius(p) for p in posts),
                       max(p["y"] + post_radius(p) for p in posts)], "count": len(posts)}


@app.get("/api/terrain")
def terrain(min_x: float, min_y: float, max_x: float, max_y: float,
            query: str = "", tags: str = ""):
    from core.terrain import energy_grid
    bounds = [min_x, min_y, max_x, max_y]
    if not all(np.isfinite(bounds)) or not (min_x < max_x and min_y < max_y):
        raise HTTPException(422, "地図の範囲が不正です。")
    if max_x - min_x > 100000 or max_y - min_y > 100000 or len(query) > 140:
        raise HTTPException(422, "地図の範囲が大きすぎます。")
    selected = [tag for tag in tags.split(',') if tag]
    if any(tag not in TAGS for tag in selected):
        raise HTTPException(422, "タグが不正です。")
    try:
        posts = state["store"].terrain_posts()
    except StoreError:
        raise HTTPException(503, "地形を読み込めませんでした。")
    needle = query.lower()
    posts = [p for p in posts if
             (not needle or needle in (p.get('body', '') + ' ' + p.get('display_name', '')).lower())
             and (not selected or any(tag in p.get('tags', []) for tag in selected))]
    return energy_grid(posts, bounds)


@app.post("/api/posts")
def create_post(payload: PostCreate, request: Request):
    """The one write that cannot happen anywhere else.

    x/y/cluster_id/vec are the frozen encoder's output. If a client could send
    them, anybody could put themselves in the middle of any island they liked,
    and the only claim this app makes - that where you are means something -
    would be false.
    """
    user_id = current_user(request)
    body = clean_body(payload.body)
    request_key = request.headers.get("Idempotency-Key")
    stable_id = None
    if request_key:
        try:
            uuid.UUID(request_key)
        except ValueError:
            raise HTTPException(422, "再試行キーが不正です。")
        canonical = json.dumps({"body": body, "tags": clean_tags(payload.tags),
            "motivation": clean_motivation(payload.motivation), "image_path": payload.image_path or None},
            sort_keys=True, ensure_ascii=False)
        stable_id = str(uuid.uuid5(uuid.NAMESPACE_URL, user_id + ':' + request_key + ':' + canonical))
        try:
            existing = state["store"].get_post(stable_id)
        except StoreError:
            raise HTTPException(503, "投稿の保存状況を確認できませんでした。")
        if existing:
            return {**existing, "island": island_of(existing["id"]), "neighbors": []}
    if not check_rate_limit(user_id):
        raise HTTPException(status_code=429, detail="少し時間をおいてからお試しください。")

    store = state["store"]
    try:
        account = store.get_account(user_id)
    except StoreError:
        raise HTTPException(status_code=503, detail="読み込みに失敗しました。もう一度お試しください。")
    if not account or not account.get("display_name"):
        raise HTTPException(status_code=409, detail="先にプロフィールを作成してください。")

    x, y, cluster_id, terms, vector, centred = project(body)
    record = {
        "author_id": user_id,
        "body": body,
        "tags": clean_tags(payload.tags),
        "motivation": clean_motivation(payload.motivation),
        "image_path": payload.image_path or None,
        "x": x,
        "y": y,
        "cluster_id": cluster_id,
        "terms": terms,
        "vec": as_pgvector(vector),
        "vec_c": as_pgvector(centred),
    }
    if state["local_mode"]:
        # MemoryStore keeps arrays, not pgvector literals.
        record["vec"] = [round(float(value), 6) for value in vector]
        record["vec_c"] = [round(float(value), 6) for value in centred]
    if stable_id:
        record["id"] = stable_id

    try:
        row = store.insert_post(record)
    except StoreError:
        raise HTTPException(
            status_code=503, detail="保存に失敗しました。もう一度「地図にのせる」を押してください。"
        )
    invalidate_islands()

    return {
        **row,
        "display_name": account.get("display_name", ""),
        "icon_id": account.get("icon_id", "0"),
        "avatar_path": account.get("avatar_path"),
        "island": island_of(row["id"]),
        "neighbors": neighbors_for(row["id"], terms, NEIGHBOR_COUNT),
    }


@app.patch("/api/posts/{post_id}")
def edit_post(post_id: str, payload: PostPatch, request: Request):
    """Editing. islands offers it from the card menu; it was an alert() there.

    Changing the body re-projects the post, which MOVES it. That is correct and
    the UI says so before saving: the map is a picture of what people wrote, so
    writing something else has to land somewhere else. Everything a post says
    about itself that is not its text - tags, mood, image - leaves it where it is.
    """
    user_id = current_user(request)
    store = state["store"]

    fields = {}
    terms = None
    if payload.body is not None:
        body = clean_body(payload.body)
        try:
            existing = store.get_post(post_id)
        except StoreError:
            raise HTTPException(status_code=503, detail="読み込みに失敗しました。")
        if not existing:
            raise HTTPException(status_code=404, detail="見つかりませんでした。")
        if existing["author_id"] != user_id:
            raise HTTPException(status_code=403, detail="自分の投稿だけ編集できます。")
        if body != existing["body"]:
            if not check_rate_limit(user_id):
                raise HTTPException(status_code=429, detail="少し時間をおいてからお試しください。")
            x, y, cluster_id, terms, vector, centred = project(body)
            fields.update({
                "body": body, "x": x, "y": y, "cluster_id": cluster_id, "terms": terms,
                "vec": as_pgvector(vector), "vec_c": as_pgvector(centred),
            })
            if state["local_mode"]:
                fields["vec"] = [round(float(value), 6) for value in vector]
                fields["vec_c"] = [round(float(value), 6) for value in centred]

    if payload.tags is not None:
        fields["tags"] = clean_tags(payload.tags)
    if payload.motivation is not None:
        fields["motivation"] = clean_motivation(payload.motivation)
    if payload.clear_image:
        fields["image_path"] = None
    elif payload.image_path is not None:
        fields["image_path"] = payload.image_path

    if not fields:
        raise HTTPException(status_code=422, detail="変更点がありません。")

    try:
        row = store.update_post(post_id, user_id, fields)
    except StoreError:
        raise HTTPException(status_code=503, detail="保存に失敗しました。もう一度お試しください。")
    if not row:
        raise HTTPException(status_code=403, detail="編集できませんでした。")
    if terms is not None:
        invalidate_islands()
    return {**row, "island": island_of(row["id"])}


@app.delete("/api/posts/{post_id}")
def delete_post(post_id: str, request: Request):
    """Soft delete. The comments other people left are their words, not ours."""
    user_id = current_user(request)
    try:
        removed = state["store"].soft_delete_post(post_id, user_id)
    except StoreError:
        raise HTTPException(status_code=503, detail="削除に失敗しました。もう一度お試しください。")
    if not removed:
        raise HTTPException(status_code=403, detail="削除できませんでした。")
    invalidate_islands()
    return {"ok": True}


@app.get("/api/neighbors")
def neighbors(post: str = "", limit: int = ORBIT_NEIGHBOR_COUNT):
    """Who is near this post, measured before the squash.

    This is what the orbit view places people by, and what the profile sheet
    prints. Never the map distance: ranking by map distance put a different
    topic at the top for 3 of 12 measured people; ranking by cosine got 12 of 12.
    """
    if not post:
        raise HTTPException(status_code=422, detail="投稿が指定されていません。")
    store = state["store"]
    try:
        origin = store.get_post(post)
    except StoreError:
        raise HTTPException(status_code=503, detail="読み込みに失敗しました。")
    if not origin:
        raise HTTPException(status_code=404, detail="見つかりませんでした。")
    limit = max(1, min(int(limit), 100))
    return {
        "post": post,
        "island": island_of(post),
        "neighbors": neighbors_for(post, origin.get("terms") or [], limit),
    }


@app.get("/api/pair")
def pair(a: str = "", b: str = ""):
    """似てる度 and shared words for two posts. What the sheet shows."""
    if not a or not b or a == b:
        raise HTTPException(status_code=422, detail="2つの投稿を指定してください。")
    store = state["store"]
    try:
        left, right = store.get_post(a), store.get_post(b)
        cosine = store.pair_similarity(a, b) if left and right else None
    except StoreError:
        raise HTTPException(status_code=503, detail="読み込みに失敗しました。")
    if not left or not right:
        raise HTTPException(status_code=404, detail="見つかりませんでした。")
    shared = shared_keywords(left.get("terms") or [], right.get("terms") or [], state["idf"])
    similarity = similarity_of(cosine)
    return {
        "similarity": similarity,
        "shared": shared,
        "note": describe_relation(similarity if similarity is not None else 0, shared),
    }


# --------------------------------------------------------------------------
# local mode: a stand-in for Supabase
#
# Active only when there is no Supabase project. Every route checks, so this
# surface simply does not exist in a deployment - it cannot be switched on with
# a flag, because there is no flag. What it is for: `uvicorn app:app` with
# nothing else running, and a test suite that needs no services.
# --------------------------------------------------------------------------

def require_local():
    if not state.get("local_mode"):
        raise HTTPException(status_code=404, detail="not found")


class OtpRequest(BaseModel):
    email: str


class OtpVerify(BaseModel):
    email: str
    code: str


class CommentCreate(BaseModel):
    post_id: str
    body: str
    reply_to: str | None = None


class ReactionChange(BaseModel):
    post_id: str
    kind: str


class ReadRequest(BaseModel):
    ids: list[str] | None = None


class ReportCreate(BaseModel):
    post_id: str | None = None
    comment_id: str | None = None
    reason: str | None = None


def _local_account_id(email):
    """A stable id per email, so restarting the browser keeps the same account."""
    digest = hashlib.sha256(f"local:{email.strip().lower()}".encode()).digest()
    return str(uuid.UUID(bytes=digest[:16]))


@app.post("/api/local/auth/otp")
def local_otp(payload: OtpRequest):
    require_local()
    email = payload.email.strip().lower()
    if "@" not in email:
        raise HTTPException(status_code=422, detail="メールアドレスを入力してください。")
    code = f"{secrets.randbelow(1_000_000):06d}"
    state["otp"][email] = {"code": code, "expires": time.time() + 600}
    print(f"[local] {email} のパスコード: {code}", flush=True)
    # Returned in the body because there is no mail server here. This route does
    # not exist when Supabase is configured, so the code cannot leak in a deploy.
    return {"ok": True, "code": code, "note": "ローカルモードのため画面に表示しています"}


@app.post("/api/local/auth/verify")
def local_verify(payload: OtpVerify):
    require_local()
    email = payload.email.strip().lower()
    record = state["otp"].get(email)
    if not record or record["expires"] < time.time():
        raise HTTPException(status_code=422, detail="パスコードの有効期限が切れています。")
    if not secrets.compare_digest(record["code"], payload.code.strip()):
        raise HTTPException(status_code=422, detail="パスコードが違います。")
    state["otp"].pop(email, None)
    account_id = _local_account_id(email)
    return {
        "access_token": auth.dev_token(account_id),
        "user": {"id": account_id, "email": email},
    }


@app.get("/api/local/account/{account_id}")
def local_get_account(account_id: str):
    require_local()
    account = state["store"].get_account(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="見つかりませんでした。")
    return account


@app.put("/api/local/account")
def local_put_account(payload: AccountPatch, request: Request):
    """The Supabase-shaped route for the same write /api/account/me does.

    Deliberately delegating rather than calling the store directly: the caps and
    the not-null rule on display_name are Postgres constraints in a deployment,
    and MemoryStore has none of them. Going through the same function is what
    keeps local mode from accepting a row the real database would refuse.
    """
    require_local()
    return account_update(payload, request)["account"]


@app.get("/api/local/map")
def local_map(min_x: float = MAP_MIN, min_y: float = MAP_MIN,
              max_x: float = MAP_MAX, max_y: float = MAP_MAX,
              limit: int = MAP_POST_LIMIT):
    require_local()
    limit = max(1, min(int(limit), 2000))
    return {"posts": state["store"].map_posts(min_x, min_y, max_x, max_y, limit)}


@app.get("/api/local/cells")
def local_cells(min_x: float = MAP_MIN, min_y: float = MAP_MIN,
                max_x: float = MAP_MAX, max_y: float = MAP_MAX):
    require_local()
    return {"cells": state["store"].map_cells(min_x, min_y, max_x, max_y)}


@app.get("/api/local/post/{post_id}")
def local_get_post(post_id: str):
    require_local()
    store = state["store"]
    post = store.get_post(post_id)
    if not post:
        raise HTTPException(status_code=404, detail="見つかりませんでした。")
    account = store.get_account(post["author_id"]) or {}
    return {
        **post,
        "display_name": account.get("display_name", ""),
        "icon_id": account.get("icon_id", "0"),
        "avatar_path": account.get("avatar_path"),
    }


@app.get("/api/local/posts")
def local_posts_by_author(author: str = ""):
    require_local()
    if not author:
        raise HTTPException(status_code=422, detail="author を指定してください。")
    return {"posts": state["store"].posts_by_author(author)}


@app.get("/api/local/comments")
def local_comments(post: str = ""):
    require_local()
    return {"comments": state["store"].list_comments(post)}


@app.post("/api/local/comments")
def local_add_comment(payload: CommentCreate, request: Request):
    require_local()
    user_id = current_user(request)
    body = payload.body.strip()[:MAX_COMMENT_LENGTH]
    if not body:
        raise HTTPException(status_code=422, detail="メッセージを入力してください。")
    try:
        comment = state["store"].add_comment(payload.post_id, user_id, body, reply_to=payload.reply_to)
    except StoreError as error:
        if str(error) == "reply_to":
            raise HTTPException(status_code=422, detail="返信先のメッセージが見つかりませんでした。")
        raise HTTPException(status_code=404, detail="投稿が見つかりませんでした。")
    invalidate_connections()
    return comment


@app.delete("/api/local/comments/{comment_id}")
def local_delete_comment(comment_id: str, request: Request):
    require_local()
    user_id = current_user(request)
    if not state["store"].delete_comment(comment_id, user_id):
        raise HTTPException(status_code=403, detail="削除できませんでした。")
    invalidate_connections()
    return {"ok": True}


@app.post("/api/local/reactions")
def local_add_reaction(payload: ReactionChange, request: Request):
    require_local()
    user_id = current_user(request)
    created = state["store"].add_reaction(payload.post_id, user_id, payload.kind)
    invalidate_connections()
    return {"ok": True, "created": created}


@app.delete("/api/local/reactions")
def local_remove_reaction(post_id: str, kind: str, request: Request):
    require_local()
    user_id = current_user(request)
    removed = state["store"].remove_reaction(post_id, user_id, kind)
    invalidate_connections()
    return {"ok": removed}


@app.get("/api/local/reactions/mine")
def local_my_reactions(request: Request):
    require_local()
    user_id = current_user(request)
    return {"reactions": state["store"].reactions_by_actor(user_id)}


@app.get("/api/local/notifications")
def local_notifications(request: Request):
    require_local()
    user_id = current_user(request)
    return {"notifications": state["store"].list_notifications(user_id)}


@app.get("/api/local/notifications/feed")
def local_notification_feed(request: Request, limit: int = 50):
    """notification_feed() for local mode: reactions grouped, settings applied.

    `interrupts` is false for a kind switched off for in_app; such entries stay
    in the list and only stop counting towards `unread`.
    """
    require_local()
    user_id = current_user(request)
    store = state["store"]
    settings = notices.merge_settings(store.get_notification_settings(user_id))
    feed = notices.group_feed(store.list_notifications(user_id, limit=500), max(1, min(int(limit), 100)))
    for entry in feed:
        entry["interrupts"] = notices.allows(settings, entry["type"], "in_app")
    unread = sum(1 for entry in feed if entry["unread"] and entry["interrupts"])
    return {"notifications": feed, "unread": unread, "settings": settings}


@app.post("/api/local/notifications/read")
def local_mark_read(payload: ReadRequest, request: Request):
    require_local()
    user_id = current_user(request)
    return {"updated": state["store"].mark_notifications_read(user_id, payload.ids)}


@app.post("/api/local/reports")
def local_report(payload: ReportCreate, request: Request):
    require_local()
    user_id = current_user(request)
    state["store"].add_report(user_id, payload.post_id, payload.comment_id, payload.reason)
    return {"ok": True}


@app.post("/api/local/upload")
async def local_upload(request: Request):
    """Stands in for Supabase Storage. Bytes in a dict, gone on restart."""
    require_local()
    user_id = current_user(request)
    raw = await request.body()
    if len(raw) > 1_048_576:
        raise HTTPException(status_code=413, detail="画像は1MBまでです。")
    kind = request.headers.get("content-type", "image/webp")
    if kind not in ("image/webp", "image/jpeg", "image/png"):
        raise HTTPException(status_code=415, detail="対応していない画像形式です。")
    path = f"{user_id}/{uuid.uuid4().hex}"
    state["images"][path] = (kind, raw)
    return {"path": path, "url": f"/api/local/image/{path}"}


@app.get("/api/local/image/{account_id}/{name}")
def local_image(account_id: str, name: str):
    require_local()
    record = state["images"].get(f"{account_id}/{name}")
    if not record:
        raise HTTPException(status_code=404, detail="見つかりませんでした。")
    kind, raw = record
    return Response(content=raw, media_type=kind, headers={"Cache-Control": "max-age=3600"})


# --------------------------------------------------------------------------
# account (both modes)
# --------------------------------------------------------------------------

@app.get("/api/account/me")
def account_me(request: Request):
    """The signed-in person's own profile, creating the row if it is missing.

    Sign-up is two steps that must not be able to come apart: GoTrue makes the
    auth user, and this makes the row everything else points at. Doing it here,
    on the first authenticated request, means a browser that closed between the
    two steps still ends up with an account rather than a token that references
    nothing.
    """
    user_id = current_user(request)
    store = state["store"]
    try:
        account = store.get_account(user_id)
    except StoreError:
        raise HTTPException(status_code=503, detail="読み込みに失敗しました。")
    return {"account": account, "new": account is None}


@app.put("/api/account/me")
def account_update(payload: AccountPatch, request: Request):
    """Save a profile. A field sent as null is CLEARED, not ignored.

    exclude_unset, not exclude_none: those two are the same thing right up
    until somebody empties a box. The edit screen sends every field on every
    save, so with exclude_none a cleared 自己紹介 arrived as "no opinion about
    bio" and the upsert left the old text in place - a profile you could write
    but never take back. exclude_unset keeps the distinction the client was
    already making: absent means leave it, null means erase it.
    """
    user_id = current_user(request)
    fields = payload.model_dump(exclude_unset=True)

    if "display_name" in fields:
        # The one field that cannot be cleared: it is what the map draws.
        name = (fields["display_name"] or "").strip()
        if not name:
            raise HTTPException(status_code=422, detail="名前を入力してください。")
        fields["display_name"] = name[:MAX_NAME_LENGTH]
    for key, cap in (
        ("affiliation", MAX_AFFILIATION_LENGTH),
        ("bio", MAX_BIO_LENGTH),
        ("link_url", MAX_LINK_LENGTH),
    ):
        if fields.get(key) is not None:
            # Trimming to empty is the same request as clearing it.
            fields[key] = str(fields[key]).strip()[:cap] or None

    store = state["store"]
    touched = [key for key in people.VECTOR_FIELDS if key in fields]
    if "topics" in fields:
        fields["topics"] = clean_topics(fields["topics"])
    for key in PROFILE_TEXT_FIELDS:
        if key in fields:
            fields[key] = clean_profile_text(fields[key])
    try:
        if touched:
            current = store.get_account(user_id) or {}
            merged = {key: fields[key] if key in fields else current.get(key) for key in people.VECTOR_FIELDS}
            try:
                # All four, in one call: unchanged texts are cache hits under
                # Gemini, and a vector missed by an earlier outage is repaired.
                fields.update(people.embed_profile(state["model"], merged))
            except Exception:
                # The words are saved anyway; a field without a vector is just
                # left out of 似ている人 until the next save.
                _logger.exception("profile embedding failed")
                fields.update({f"vec_{key}": None for key in touched})
        account = store.upsert_account(user_id, fields)
    except StoreError:
        raise HTTPException(status_code=503, detail="保存に失敗しました。もう一度お試しください。")
    if touched and any(fields.get(f"vec_{key}") is not None for key in people.VECTOR_FIELDS):
        try:
            notify_similar(user_id)
        except StoreError:
            _logger.exception("similar-person notification failed")
    return {"account": account}


# --------------------------------------------------------------------------
# static
# --------------------------------------------------------------------------

NO_CACHE = {"Cache-Control": "no-cache"}


@app.get("/")
def index():
    return FileResponse(WEB / "index.html", headers=NO_CACHE)


@app.get("/how")
def how():
    return FileResponse(WEB / "how.html", headers=NO_CACHE)


@app.get("/docs")
def docs_page():
    return FileResponse(WEB / "docs.html", headers=NO_CACHE)


class RevalidatingStatics(StaticFiles):
    """Serve assets with `no-cache` so a redeploy actually reaches returning users.

    `no-cache` does not mean "do not cache" - it means "revalidate before use".
    The browser still keeps the file and still gets a cheap 304 when nothing
    changed, but it can never serve a stale module against a new index.html.
    """

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/static", RevalidatingStatics(directory=WEB), name="static")


@app.exception_handler(HTTPException)
async def http_exception_handler(_request, exc):
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 7860)))
