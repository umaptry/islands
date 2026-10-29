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
  POST /api/push/*        Web Push needs the VAPID private key, and the server
                          is the one that POSTs to a subscription's endpoint

Everything at request time is a pure forward pass through frozen artifacts.
Nothing here fits a vectorizer, retrains an encoder, or recomputes a layout, so
posting can never move anybody who already posted.

The /api/local/* block at the bottom is a stand-in for Supabase, active only
when there is no Supabase project configured. It is what makes `uvicorn app:app`
work with nothing else running.
"""

import copy
import hashlib
import io
import json
import logging
import math
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
from urllib.parse import urlsplit

import httpx
import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from typing import Any
from pydantic import BaseModel, Field

from core import affinity as people
from core import auth
from core import connections as lines
from core import growth
from core import introductions
from core import island_namer
from core import matching
from core import island_tracking
from core import notifications as notices
from core import quiet
from core import webpush
from core.clustering import assign_cluster, name_group
from core.prompts import weekly_prompt
from core import post_extras
from core.config import (
    AWAY_DIGEST_COUNT,
    COMMUNITY_ERROR_POST,
    DM_BODY_MAX,
    EXAMPLE_POSTS,
    EXTRA_PROMPTS,
    POST_STARTERS,
    RECRUIT_TAG,
    SHARE_COMMUNITIES_MAX,
    SHARE_ERROR_FAILED,
    SHARE_ERROR_LONG,
    SHARE_ERROR_NONE,
    SHARE_ERROR_OFF,
    SHARE_ERROR_SYNC,
    TALK_LABEL,
    PREVIEW_ISLAND_RADIUS,
    PREVIEW_NEIGHBORS,
    CONNECTION_CACHE_SECONDS,
    MATCH_CANDIDATES,
    MATCH_LIMIT,
    CONNECTIONS_SINCE,
    DIGEST_CONTRIBUTORS,
    ISLAND_COLORS,
    ISLAND_GENRES,
    ISLAND_NOTIFY_PER_DAY,
    ISLAND_RESIDENTS_SHOWN,
    ISLAND_NAME_PENDING_LABEL,
    ISLAND_NAME_PENDING_MAX_SECONDS,
    ISLAND_NAMING_MIN_AUTHORS,
    ISLAND_NAMING_MIN_POSTS,
    ISLAND_RUN_MIN_SECONDS,
    ISLAND_RUN_PENDING_SECONDS,
    LANDMARK_CANDIDATES,
    MAP_MAX,
    MAP_MIN,
    MAP_POST_LIMIT,
    MAX_AFFILIATION_LENGTH,
    MEMBERS_ONLY_COMMUNITY_REQUIRED,
    MEMBERS_ONLY_NOT_FOUND,
    MEMBERS_ONLY_UNAVAILABLE,
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
    NEVER_PUSHED,
    LEGACY_NOTIFICATION_CATEGORIES,
    NOTIFICATION_CATEGORIES,
    ORBIT_NEIGHBOR_COUNT,
    PERSON_CARD_CONNECTIONS,
    PROFILE_TEXT_FIELDS,
    PROFILE_TEXT_LENGTH,
    PROFILE_TOPIC_LENGTH,
    PROFILE_TOPIC_MAX,
    PRESENCE_HOLD_SECONDS,
    PRESENCE_PING_SECONDS,
    PUSH_FRESH_MINUTES,
    PUSH_TTL_SECONDS,
    QUIET_POST_ENABLED,
    QUIET_POST_MAX_DAYS,
    QUIET_POST_VISIT_DAYS,
    RESIDENT_NOTIFY_PER_DAY,
    RESIDENT_NOTIFY_PER_PERSON_DAY,
    SIMILAR_NOTIFY_PER_DAY,
    SIMILAR_NOTIFY_THRESHOLD,
    SIMILAR_PEOPLE_COUNT,
    TAGS,
)
from core.encoder import load_encoder
from core.energy import constants as energy_constants, reach_factor
from core.artifact_manifest import SEED_VECTORS
from core.placement import place_by_seeds, placement_spots
from core.energy import name_landmasses
from core.features import build_hybrid_features, extract_label_terms, normalize_text, use_preprocessing
from core.geometry import scale_projected_coordinate
from core.similarity import (
    SPARSE_DIM,
    cosine_percent,
    describe_relation,
    map_view,
    reads_map_view,
    resolve_scale,
    shared_keywords,
    similarity_view,
)
from core.store import InviteRequired, Refused, StoreError, TalkRefused, create_store

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
SIMILAR_NOTIFY_ENABLED = False  # 「似た人」通知の停止（false のまま）
ISLAND_AUTO_TRACK = os.environ.get("ISLANDS_AUTO_TRACK", "1") == "1"
# Likewise for Web Push: tests call dispatch_pushes() themselves.
PUSH_AUTO = os.environ.get("ISLANDS_AUTO_PUSH", "1") == "1"
# A burst of pokes runs the dispatcher at most once per this many seconds.
PUSH_MIN_GAP_SECONDS = 1.0
PUSH_URL = "/#/notifications"
# A "new resident" push opens the map, where the catch-up shows who moved in.
PUSH_URL_RESIDENT = "/#/map"

_logger = logging.getLogger(__name__)

# Cloud Run only shows what reaches stderr: let the island namer's INFO line (the check
# right after switching AI names on) through, and leave every other logger as it was.
_namer_logger = logging.getLogger("core.island_namer")
if _namer_logger.getEffectiveLevel() > logging.INFO:
    _namer_logger.setLevel(logging.INFO)
if not _namer_logger.handlers:
    _namer_handler = logging.StreamHandler()  # stderr
    _namer_handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    _namer_logger.addHandler(_namer_handler)

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
# members_only: one cache and one lock per community (an island of A must never be answered from
# B's posts). Computed lazily on the first request for a community.
_community_islands = {}
_community_islands_guard = threading.Lock()

# Lines between people. In a deployment the browser writes reactions and
# comments straight to Supabase, so the server cannot know when a line changes;
# it re-reads at most every CONNECTION_CACHE_SECONDS instead.
_connections_cache = {"stamp": 0.0, "value": None}
_community_connections_cache = {}   # community id -> {"stamp", "value"}: the lines of that community's map
_connections_lock = threading.Lock()
# Held while one tracking step runs in this process. The database claim
# (claim_island_run) is what keeps two instances apart.
_island_run_lock = threading.Lock()
# One push dispatcher per process. A poke while it runs asks for one more pass
# instead of starting a second thread; claim_pending_pushes() is what keeps two
# processes from sending the same row.
_push_lock = threading.Lock()
_push_state = {"running": False, "again": False}
_push_keys = {"store": None, "pair": None, "dispatch_url": None}


# --------------------------------------------------------------------------
# startup
# --------------------------------------------------------------------------

def load_artifacts():
    """Load the frozen map. Missing artifacts is a hard failure, not a warning."""
    from core.artifact_manifest import validate_manifest
    manifest = validate_manifest(ARTIFACTS, os.environ.get("EMBEDDING_PROVIDER", "onnx"))
    # Texts are read with the stop words this map was built with (core.features).
    use_preprocessing(manifest["embedding"]["preprocessing"])
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

    # A map placed by its seeds (core.placement) needs their map-view vectors.
    placement = None
    if (seed_map.get("placement") or {}).get("method") == "seed_mode":
        vectors = np.load(ARTIFACTS / SEED_VECTORS).astype(float)
        spots = placement_spots(seed_map)   # seeds, then their variants
        if vectors.shape != (len(spots), encoder.input_dim):
            raise RuntimeError("seed_vectors.npy がシードの数・次元と合いません。")
        placement = dict(seed_map["placement"], vectors=vectors, spots=spots)

    # A map built on the centred view needs its centroid to place anything at
    # all, so it is taken here unconditionally - not through resolve_scale,
    # which may drop it for 似てる度 and fall back, and must never do that to
    # the encoder's input (core.similarity.map_view).
    centroid = seed_map.get("cosine_centroid")
    map_centroid = centroid if reads_map_view(centroid) else None
    if map_centroid is not None and len(map_centroid.get("dense_mean") or []) + SPARSE_DIM != encoder.input_dim:
        raise RuntimeError("seed_map.json の cosine_centroid がエンコーダの入力と合いません。")
    if placement is not None and map_centroid is None:
        raise RuntimeError("シードで置く地図には中心化した見方（cosine_centroid.map_input）が要ります。")

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
        "map_centroid": map_centroid,
        "placement": placement,
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
    if state["local_mode"] and not local_mode_allowed():
        # A production deploy that lost SUPABASE_URL / SUPABASE_SERVICE_KEY would otherwise quietly
        # become an open server whose login hands the code out on screen and whose dev switches
        # (the invite_only switch, expiring an invite) need no login. Stop instead.
        raise RuntimeError(
            "SUPABASE_URL / SUPABASE_SERVICE_KEY が未設定のまま Cloud Run で起動しようとしました。"
            "環境変数を確かめてください（手元モードは ISLANDS_LOCAL=1 のときだけ許されます）。")
    if _gemini and not state["local_mode"] and os.environ.get("MAP_RUNTIME_CHECK") != "1":
        raise RuntimeError("Production Gemini requires MAP_RUNTIME_CHECK=1 and the model-runtime migration")
    state["images"] = {}
    state["otp"] = {}
    if PUSH_AUTO:
        if hasattr(state["store"], "on_notify"):
            state["store"].on_notify = poke_push_dispatch
        # Whatever arrived while this server was asleep: fresh rows go out,
        # older ones are marked and dropped.
        poke_push_dispatch()

    if state["local_mode"]:
        # The 「デモ」 community and its fixed invite code (for tests and for trying the screens
        # by hand), and the optional switch for invite-only sign-up. Local mode only.
        state["store"].seed_demo_community()
        if os.environ.get("ISLANDS_LOCAL_INVITE_ONLY") == "1":
            state["store"].set_invite_only(True)
        if os.environ.get("ISLANDS_LOCAL_MEMBERS_ONLY") == "1":
            state["store"].set_members_only(True)
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
    path = request.url.path
    # /api/push/* touches no map data, and the dispatch poke comes from the
    # database after every notification: no runtime lookup for those.
    protected = (path.startswith('/api/') and path not in ('/api/health', '/api/config')
                 and not path.startswith('/api/push/'))
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
    response = await call_next(request)
    # members_only: nothing derived from a community's posts may sit in a shared cache. The routes
    # that set their own Cache-Control keep it; the rest are told here (the switch's last value).
    if (state.get("members_only_hint") and path.startswith("/api/")
            and path not in ("/api/health", "/api/config") and not path.startswith("/api/local/image/")
            and "cache-control" not in response.headers):
        response.headers["Cache-Control"] = "private, no-store"
    return response


# --------------------------------------------------------------------------
# request models
# --------------------------------------------------------------------------

class PostCreate(BaseModel):
    body: str = Field(min_length=1)
    tags: list[str] = Field(default_factory=list)
    motivation: int = MOTIVATION_DEFAULT
    image_path: str | None = None
    # 2026-10-20. prompt: "weekly" | "past" | "now" | "future" | "help" (2026-10-28) | null. The recruit_*
    # fields count only for a post tagged 参加者募集中. Checked by core.post_extras
    # (Any, so a wrong type gets the same Japanese message as a wrong value).
    prompt: str | None = None
    recruit_deadline: Any = None
    recruit_capacity: Any = None
    # 2026-10-26. The community whose map this post belongs to. Ignored while
    # features.communities is false; otherwise the author must be a member.
    community_id: str | None = None


class PostPreview(BaseModel):
    body: str = Field(min_length=1)
    # members_only: the community whose map the text would stand on. Left out, the only
    # community of the caller is taken; several and none named is a 422.
    community_id: str | None = None


class PostView(BaseModel):
    # A signed-out browser's own random key; ignored when signed in.
    viewer: str | None = None


class PostPatch(BaseModel):
    body: str | None = None
    tags: list[str] | None = None
    motivation: int | None = None
    image_path: str | None = None
    # 2026-10-20. Absent leaves the value alone; null erases it.
    prompt: str | None = None
    recruit_deadline: Any = None
    recruit_capacity: Any = None
    # Explicit rather than a DELETE-only path: islands' card menu offers edit
    # and delete from the same place, and both are the author changing their
    # own row.
    clear_image: bool = False


class PostShare(BaseModel):
    # 2026-10-29: the other communities (of the author's) to put the post on too.
    community_ids: list[str] = Field(default_factory=list, max_length=SHARE_COMMUNITIES_MAX)


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


class PushSubscriptionKeys(BaseModel):
    p256dh: str = Field(max_length=200)
    auth: str = Field(max_length=100)


class PushSubscribe(BaseModel):
    # PushSubscription.toJSON(); expirationTime is ignored.
    endpoint: str = Field(max_length=1000)
    keys: PushSubscriptionKeys


class PushUnsubscribe(BaseModel):
    endpoint: str = Field(max_length=1000)


class Presence(BaseModel):
    seconds: int = 0


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


def check_rate_limit(key, maximum=None):
    if RATE_LIMIT_OFF:
        return True
    maximum = RATE_LIMIT_MAX if maximum is None else maximum
    now = time.time()
    with _rate_lock:
        log = _rate_log[key]
        while log and now - log[0] > RATE_LIMIT_WINDOW:
            log.popleft()
        if len(log) >= maximum:
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


def post_extras_on():
    """Whether the database can keep the prompt / sign-up fields (2026-10-20).

    False until supabase/migrations/20261020000000_post_prompts_and_recruit.sql has
    been run on the production database; the memory store always can. While it is
    False the fields are ignored (never sent to the database) and the screen is told
    through features.post_extras."""
    return bool(getattr(state["store"], "supports_post_extras", True))


def share_on():
    """Whether a post can be put on the maps of other communities too (2026-10-29).

    Needs the database columns (supabase/migrations/20261029000000_share_group.sql; the memory
    store always has them) and the members-only rules: a copy per community only means something
    where every community has a map of its own. Unknown counts as off (nothing is offered)."""
    try:
        if not _members_flag():
            return False
    except StoreError:
        return False
    return bool(getattr(state["store"], "supports_share", True))


def talk_on():
    """Whether 「話してみたい」/ DM can run (2026-10-26).

    False until supabase/migrations/20261026000000_talk_and_dm.sql has been run on the
    production database; the memory store always can. The screen shows nothing while
    this is False, so the code may go out before the SQL."""
    return bool(getattr(state["store"], "supports_talk", True))


def communities_on():
    """Whether communities and invite links can run (2026-10-26).

    False until supabase/migrations/20261026010000_communities_and_invites.sql has been run
    on the production database; the memory store always can. While it is False the screen
    keeps the old behaviour (one map for everybody, sign-up without an invite) and a
    community_id sent with a post is ignored.

    While members_only is on this is ALWAYS True and the cached table check is never consulted:
    a transient failure of that check (it answers False at a cold start) must not turn the
    communities, and with them the membership rule, off."""
    try:
        if _members_flag():
            return True
    except StoreError:
        pass
    return bool(getattr(state["store"], "supports_communities", True))


# --------------------------------------------------------------------------
# members only: a post of a community is read by that community's members only
# --------------------------------------------------------------------------
#
# The server uses the service key, so the database's row level security never protects a path
# that goes through here. Every route that returns anything derived from posts therefore starts
# from ONE gate, and the gate is switched by app_settings.members_only (read through the store and
# cached for a few seconds):
#
#   members_only_on()        True / False; 503 when the switch cannot be read (never a guess)
#   require_member(u, cid)   404 unless u belongs to community cid right now (not cached);
#                            the 404 is the one for a missing post, so nothing is revealed
#   member_post(u, post_id)  the post, for a MEMBER of its community (an author who has left does
#                            not count: the author may only read their own row, elsewhere)
#
# While the switch is false none of this runs and every route answers as before.

def _members_flag():
    """The switch as the store last read it. Raises StoreError when it cannot be read."""
    reader = getattr(state["store"], "members_only", None)
    value = bool(reader()) if callable(reader) else False
    state["members_only_hint"] = value   # only for the Cache-Control header in the middleware, never a gate
    return value


def members_only_on():
    """Whether the members-only rules apply. A database that cannot be asked is a 503: guessing
    "off" would open every community, guessing "on" would lock out a working map."""
    try:
        return _members_flag()
    except StoreError:
        raise HTTPException(status_code=503, detail=MEMBERS_ONLY_UNAVAILABLE)


def members_only_quiet():
    """members_only for code that must not raise (what to hide in a public answer): unknown
    counts as ON, the closed side."""
    try:
        return _members_flag()
    except StoreError:
        return True


def _norm_uuid(value):
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, AttributeError, TypeError):
        return None


def viewer_communities(user_id):
    """The communities a person belongs to right now (read fresh: never cached, so a person who
    just claimed an invite sees the community on the next request)."""
    try:
        return {str(cid) for cid in state["store"].viewer_communities(user_id)}
    except StoreError:
        raise HTTPException(status_code=503, detail=MEMBERS_ONLY_UNAVAILABLE)


def require_member(user_id, community_id):
    """The community id (normalised) when `user_id` belongs to it, else the 404 of a missing post."""
    cid = _norm_uuid(community_id) if community_id else None
    if not cid or cid not in viewer_communities(user_id):
        raise HTTPException(status_code=404, detail=MEMBERS_ONLY_NOT_FOUND)
    return cid


def community_param(user_id, community):
    """A required ?community= for a read: 422 when absent, 404 unless the caller is a member."""
    if not community:
        raise HTTPException(status_code=422, detail=MEMBERS_ONLY_COMMUNITY_REQUIRED)
    return require_member(user_id, community)


def member_post(user_id, post_id):
    """A live post that `user_id` may read as a member of its community; else the 404 of a
    missing post (a post of another community, one with no community and a bad id look alike)."""
    pid = _norm_uuid(post_id)
    if not pid:
        raise HTTPException(status_code=404, detail=MEMBERS_ONLY_NOT_FOUND)
    try:
        post = state["store"].get_post(pid)
    except StoreError:
        raise HTTPException(status_code=503, detail="読み込みに失敗しました。")
    if not post:
        raise HTTPException(status_code=404, detail=MEMBERS_ONLY_NOT_FOUND)
    require_member(user_id, post.get("community_id"))
    return post


def only_community_of(user_id, named=None):
    """The community a write goes to: the one named (the caller must belong), else their only one.
    422 when they belong to several and named none, 403 (the old words) when to none."""
    comms = viewer_communities(user_id)
    if named:
        cid = _norm_uuid(named)
        if not cid or cid not in comms:
            raise HTTPException(status_code=403, detail=COMMUNITY_ERROR_POST)
        return cid
    if len(comms) == 1:
        return next(iter(comms))
    if not comms:
        raise HTTPException(status_code=403, detail=COMMUNITY_ERROR_POST)
    raise HTTPException(status_code=422, detail=MEMBERS_ONLY_COMMUNITY_REQUIRED)


def scoped(community):
    """store keyword arguments for a read of one community ({} for the old all-posts read)."""
    return {} if community is None else {"community": community}


def invite_only_on():
    """Whether new accounts need an invite (app_settings.invite_only; about a minute of
    cache in the production store). Always False while communities are off."""
    if not communities_on():
        return False
    try:
        return bool(state["store"].invite_only())
    except StoreError:
        return False


def extras_for_new_post(payload, tags):
    """The prompt / sign-up columns of a new post. Raises HTTPException 422."""
    try:
        extras = {"prompt": post_extras.clean_prompt(payload.prompt),
                  "recruit_deadline": None, "recruit_capacity": None}
        if RECRUIT_TAG in tags:
            extras["recruit_deadline"] = post_extras.clean_deadline(payload.recruit_deadline)
            extras["recruit_capacity"] = post_extras.clean_capacity(payload.recruit_capacity)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))
    return extras


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
    placement = state.get("placement")
    if placement is not None:
        # Where its nearest seeds in meaning stand (core.placement).
        x, y = (float(value) for value in place_by_seeds(
            map_input(vector), placement["vectors"], placement["spots"], k=placement["k"],
            temperature=placement["temperature"], bandwidth=placement["bandwidth"]))
    else:
        raw = state["encoder"](map_input(vector))
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


def map_input(vector):
    """What the frozen encoder reads: the stored vector itself for a map built
    that way, or its centred view for one built on that (manifest schema 2)."""
    centroid = state.get("map_centroid")
    return vector if centroid is None else map_view(vector, centroid)


_reach_cache = {"stamp": 0.0, "value": 1.0}
_community_reach = {}   # community id -> {"stamp", "value"}


def current_reach_factor(community=None):
    """core.energy.reach_factor for the posts on the map now, recounted at most
    once a minute: the browser and the server's island grouping use it alike.
    With `community` it is that community's own map (members_only)."""
    now = time.time()
    if community:
        held = _community_reach.get(community)
        if held is None or now - held["stamp"] >= ISLAND_CACHE_SECONDS:
            try:
                value = reach_factor(state["store"].count_posts(community=community))
            except StoreError:
                value = held["value"] if held else 1.0   # keep the last one
            held = _community_reach[community] = {"stamp": now, "value": value}
        return held["value"]
    if now - _reach_cache["stamp"] >= ISLAND_CACHE_SECONDS:
        try:
            _reach_cache["value"] = reach_factor(state["store"].count_posts(everything=True))
        except StoreError:
            pass  # keep the last one
        _reach_cache["stamp"] = now
    return _reach_cache["value"]


def as_pgvector(values):
    """pgvector accepts its literal text form over PostgREST."""
    return "[" + ",".join(f"{float(value):.6f}" for value in values) + "]"


def _island_holder(community):
    """(cache dict, lock) of the all-posts islands, or of one community's."""
    if community is None:
        return _islands_cache, _islands_lock
    with _community_islands_guard:
        holder = _community_islands.get(community)
        if holder is None:
            holder = _community_islands[community] = {
                "stamp": 0.0, "value": [], "key": None, "lock": threading.Lock()}
    return holder, holder["lock"]


def live_islands(force=False, community=None):
    """Landmasses, named by the people standing on them.

    islands decided a post's genre by matching its text against a table of
    twelve hand-written keyword lists. That was the best it could do with random
    coordinates. Here the coordinates carry meaning, so the name comes from the
    words of the posts on the landmass, ranked by how many people used them and
    how rare they are in the seed corpus. A landmass with nothing nameable on it
    gets no name and is not drawn with one: the map starts as open water and
    grows names as people arrive.
    """
    cache, lock = _island_holder(community)
    now = time.time()
    with lock:
        fresh = now - cache["stamp"] < ISLAND_CACHE_SECONDS
        if fresh and not force and cache["key"] is not None:
            return cache["value"]

    try:
        posts = state["store"].list_terms(limit=NAMING_POST_LIMIT, **scoped(community))
    except StoreError:
        # Keep whatever was last computed rather than blanking every label.
        with lock:
            return cache["value"]

    if len(posts) >= NAMING_POST_LIMIT:
        _logger.warning("island naming capped at %d posts; some posts will have no island membership", NAMING_POST_LIMIT)

    named = name_landmasses(posts, state["idf"], name_group, reach_factor(len(posts)))
    # Word counts only say what the islanders mention; the heading is the activity genre.
    named = name_by_genre(named, {post["id"]: post for post in posts})
    try:
        # Islands that already have an AI name keep showing it (no network).
        saved = (state["store"].island_states(communities={community}) if community
                 else state["store"].island_states())
        named = island_namer.overlay(named, saved)
    except StoreError:
        pass
    pending = hide_unnamed_genre_names(named, {post["id"]: post for post in posts}, community, now)
    attach_residents(named, posts)
    # Explicit membership replaces the client's former centre-distance guess.
    payload = named
    membership = {}
    for index, island in enumerate(named):
        for post_id in island["post_ids"]:
            membership[post_id] = index

    with lock:
        cache.update({"stamp": now, "value": payload, "key": membership})
    state.setdefault("naming_pending", {})[community or ""] = pending
    return payload


def island_naming_available():
    """True when the AI namer can run here (key set, naming on, migration in). Loads it once."""
    try:
        if not getattr(state["store"], "supports_island_names", True):
            return False
        namer = state.get("island_namer")
        if namer is None and "island_namer" not in state:
            namer = state["island_namer"] = island_namer.load_namer()
        return namer is not None
    except Exception:
        return False


def hide_unnamed_genre_names(named, posts_by_id, community, now):
    """While the AI has not named an island yet, show 'thinking' instead of the genre-vote name.

    Only where the AI namer is available. An island that was asked and got no usable answer
    (name_tried_at), or has waited ISLAND_NAME_PENDING_MAX_SECONDS, goes back to its genre name.
    The genre name is kept in genre_name / genre_label; track_islands puts it back before
    naming and saving. Returns how many islands are waiting.
    """
    seen = state.setdefault("pending_since", {})
    if not named or not island_naming_available():
        return 0
    live_keys, waiting = set(), 0
    for island in named:
        post_ids = island.get("post_ids") or []
        if (island.get("name_source") in ("ai", "manual") or island.get("name_hold") or not island.get("name")
                or len(post_ids) < ISLAND_NAMING_MIN_POSTS):
            continue
        authors = {posts_by_id[pid].get("author_id") for pid in post_ids
                   if pid in posts_by_id and posts_by_id[pid].get("author_id")}
        if len(authors) < ISLAND_NAMING_MIN_AUTHORS:
            continue
        if island_namer.tried_recently(island, datetime.now(timezone.utc)):
            continue  # asked, no usable answer: the genre name stands
        key = (community or "", min(post_ids))
        live_keys.add(key)
        if now - seen.setdefault(key, now) >= ISLAND_NAME_PENDING_MAX_SECONDS:
            continue
        island["genre_name"], island["genre_label"] = island["name"], island.get("label") or island["name"]
        island["name"] = island["label"] = ISLAND_NAME_PENDING_LABEL
        island["name_pending"] = True
        waiting += 1
    for key in [key for key in seen if key[0] == (community or "") and key not in live_keys]:
        del seen[key]
    return waiting


def reveal_genre_names(islands):
    """Undo hide_unnamed_genre_names on a copy, so naming and saving see the real names."""
    for island in islands:
        if island.pop("name_pending", None):
            island["name"] = island.pop("genre_name")
            island["label"] = island.pop("genre_label")
    return islands


def _created_stamp(value):
    try:
        return notices.parse_time(value).timestamp()
    except (ValueError, TypeError, OverflowError, OSError):
        return 0.0


def attach_residents(islands, posts):
    """Put on each island who lives there: `residents` (newest poster first, at most
    ISLAND_RESIDENTS_SHOWN, with the profile bits a face needs) for the page, and the internal
    `resident_ids` (every writer, newest first) and `author_counts` (posts per writer) for the
    'moved in' notice. Accounts are read once for all islands, when the cache is rebuilt."""
    by_id = {post["id"]: post for post in posts}
    wanted = []
    for island in islands:
        latest, counts = {}, Counter()
        for post_id in island.get("post_ids") or []:
            post = by_id.get(post_id) or {}
            author = post.get("author_id")
            if not author:
                continue
            counts[author] += 1
            latest[author] = max(latest.get(author, 0.0), _created_stamp(post.get("created_at")))
        island["resident_ids"] = sorted(latest, key=lambda author: -latest[author])
        island["author_counts"] = dict(counts)
        wanted.extend(island["resident_ids"][:ISLAND_RESIDENTS_SHOWN])
    accounts = {}
    ids = sorted(set(wanted))
    for start in range(0, len(ids), 40):
        try:
            for row in state["store"].list_accounts(ids[start:start + 40]):
                accounts[row["id"]] = row
        except Exception as error:  # faces are a nicety: the island is still drawn without them
            _logger.warning("island residents: accounts unavailable (%s)", type(error).__name__)
    for island in islands:
        island["residents"] = [
            {"id": who, "display_name": accounts[who].get("display_name") or "",
             "icon_id": accounts[who].get("icon_id", "0"), "avatar_path": accounts[who].get("avatar_path")}
            for who in island["resident_ids"][:ISLAND_RESIDENTS_SHOWN] if who in accounts]
    return islands


# Bookkeeping of island naming (post-id lists, timestamps): kept out of API answers.
_INTERNAL_ISLAND_KEYS = ("genre_name", "genre_label", "name_basis", "name_tried_at", "name_hold", "resident_ids", "author_counts")


def island_intro(island):
    """The one-line intro: the AI's, else a plain sentence from the island's topic words
    (not the island's own name), else None."""
    if island.get("intro") and not island.get("name_hold"):
        return island["intro"]
    own = {island.get("name"), island.get("label")}
    words = []
    for word in island.get("topics") or []:
        if word and word not in own and word not in words:
            words.append(word)
    words = words[:2]
    if not words:
        return None
    return "".join(f"「{word}」" for word in words) + "の話をする人たちが住んでいます"


def public_island(island):
    """A copy of a live island without the naming bookkeeping; name_source is always set,
    `intro` is a sentence or None, `residents` is always a list."""
    row = {key: value for key, value in island.items() if key not in _INTERNAL_ISLAND_KEYS}
    row["name_source"] = "terms" if island.get("name_hold") else (island.get("name_source") or "terms")
    row["intro"] = island_intro(island)
    row["residents"] = list(island.get("residents") or [])
    return row


def island_entry(post_id, community=None):
    """The cached live island (with its internal keys) a post stands on, or None."""
    live_islands(**({} if community is None else {"community": community}))
    cache, lock = _island_holder(community)
    with lock:
        membership = cache["key"] or {}
        islands = cache["value"]
    index = membership.get(post_id)
    return islands[index] if index is not None and index < len(islands) else None


def island_of(post_id, community=None):
    """The landmass a post is standing on, as it is named right now (among its community's posts
    when `community` is given: members_only)."""
    entry = island_entry(post_id, community)
    return public_island(entry) if entry is not None else None


def island_for_viewer(post, user_id):
    """The island a post stands on, for the person who wrote it. With members_only on, a person who
    has left the community gets none: islands are for members."""
    if not members_only_quiet():
        return island_of(post["id"])
    community = post.get("community_id")
    if not community or str(community) not in viewer_communities(user_id):
        return None
    return island_of(post["id"], str(community))


def invalidate_islands():
    with _islands_lock:
        _islands_cache["stamp"] = 0.0
    with _community_islands_guard:
        holders = list(_community_islands.values())
    for holder in holders:
        with holder["lock"]:
            holder["stamp"] = 0.0


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


def people_index(communities=None):
    """Everybody's profile fields, hidden vectors and post centroid, by id.

    With `communities` (members_only): only the people who belong to one of them, and each
    centroid is the mean of their posts IN those communities (account_post_centroids per
    community, merged by post count), never of posts elsewhere."""
    store = state["store"]
    if communities is None:
        centroids = store.post_centroids()
        allowed = None
    else:
        allowed, sums = set(), {}
        for community in sorted(communities):
            allowed |= set(store.community_member_ids(community))
            for author, found in store.post_centroids(community=community).items():
                count = int(found.get("post_count") or 0)
                if not count or found.get("centroid") is None:
                    continue
                total, seen = sums.get(author, (None, 0))
                weighted = np.asarray(found["centroid"], dtype=float) * count
                sums[author] = (weighted if total is None else total + weighted, seen + count)
        centroids = {author: {"centroid": [float(v) for v in total / seen], "post_count": seen}
                     for author, (total, seen) in sums.items()}
    index = {}
    for row in store.profile_vectors():
        if allowed is not None and row["id"] not in allowed:
            continue
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
    # 2026-10-12: 「似た人」の通知は作らない（モック反映の決定）。関数と呼び出しは
    # 互換のために残し、何も書かずに空を返す。
    if not SIMILAR_NOTIFY_ENABLED:
        return []
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


def islands_by_author(posts=None, communities=None):
    """author -> labels of the islands their posts stand on, most posts first.
    With `communities` (members_only): the islands of those communities only."""
    if posts is None:
        if communities is None:
            posts = state["store"].list_terms(limit=NAMING_POST_LIMIT)
        else:
            posts = [post for community in sorted(communities)
                     for post in state["store"].list_terms(limit=NAMING_POST_LIMIT, community=community)]
    author_of = {post["id"]: post.get("author_id") for post in posts}
    counts = defaultdict(Counter)
    islands = (live_islands() if communities is None else
               [island for community in sorted(communities) for island in live_islands(community=community)])
    for island in islands:
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


CONNECTION_BROWSER_SECONDS = 10
FRESH_LINES_MIN_SECONDS = 2.0
_fresh_lines = {"stamp": 0.0}


def fresh_lines_due():
    """Whether a requested recount may run now: one every couple of seconds at most."""
    now = time.time()
    with _connections_lock:
        if now - _fresh_lines["stamp"] < FRESH_LINES_MIN_SECONDS:
            return False
        _fresh_lines["stamp"] = now
        return True


def connection_lines(force=False, community=None):
    """Every line between two people, strongest first (cached briefly).

    With `community`, only that community's map: the lines come from interactions on its posts and
    end on its posts (a person who is in two communities has a line on each map, never one that
    runs to a post on another map)."""
    now = time.time()
    with _connections_lock:
        holder = _connections_cache if not community else _community_connections_cache.get(community)
        cached = holder["value"] if holder else None
        if cached is not None and not force and now - holder["stamp"] < CONNECTION_CACHE_SECONDS:
            return cached
    store = state["store"]
    events = store.interaction_events(since=CONNECTIONS_SINCE)
    # A line ends on the post the last interaction landed on and on the other
    # person's post standing closest to it; somebody with no post that has a
    # place is drawn from their most energetic one.
    posts = store.list_terms(limit=NAMING_POST_LIMIT, **scoped(community or None))
    if community:
        # The community's posts come straight from the store (community_id is a term column), so
        # an event counts only when it landed on one of them.
        in_community = {post["id"] for post in posts}
        events = [event for event in events if event.get("post_id") in in_community]
    where, best = home_posts(posts)
    by_author = defaultdict(list)
    for post in posts:
        if post["id"] in where and post.get("author_id"):
            by_author[post["author_id"]].append(post["id"])
    value = lines.build(
        events, fallback_posts={author: post["id"] for author, post in best.items()},
        positions={post_id: (spot["x"], spot["y"]) for post_id, spot in where.items()},
        posts_by_author=by_author,
    )
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
        if community:
            _community_connections_cache[community] = {"stamp": now, "value": value}
        else:
            _connections_cache.update({"stamp": now, "value": value})
    return value


def lines_of_communities(communities, force=False):
    """The lines of each of several communities, one after the other (members_only: a viewer sees
    the maps of the communities they belong to, and a line never joins two of them)."""
    rows = []
    for community in sorted(communities):
        rows.extend(connection_lines(force=force, community=community))
    return rows


def invalidate_connections():
    with _connections_lock:
        _connections_cache["stamp"] = 0.0
        _community_connections_cache.clear()


def landmark_ranker(islands, posts_by_id):
    """island -> LANDMARK_CANDIDATES ordered by closeness to the island's words.

    One encode call for every island; the candidates are encoded once per
    process. Both sides are centred on the seed mean, as profiles are.
    """
    model = state["model"]
    texts = [island_text(island, posts_by_id) for island in islands]
    if not texts:
        return None
    if state.get("landmark_vectors") is None:
        state["landmark_vectors"] = np.asarray(
            model.encode(list(LANDMARK_CANDIDATES), normalize_embeddings=True), dtype=float)
    candidates = centred_units(state["landmark_vectors"])
    ranked = {}
    for island, unit_vector in zip(islands, centred_units(model.encode(texts, normalize_embeddings=True))):
        scores = candidates @ unit_vector
        order = sorted(range(len(LANDMARK_CANDIDATES)), key=lambda k: (-float(scores[k]), k))
        ranked[id(island)] = [LANDMARK_CANDIDATES[k] for k in order]
    return lambda island: ranked.get(id(island))


def island_text(island, posts_by_id, lead=None):
    """The island's words as one sentence for the encoder: its own, then its posts' commonest terms."""
    counts = Counter()
    for post_id in island.get("post_ids") or []:
        counts.update(set((posts_by_id.get(post_id) or {}).get("terms") or []))
    words = list(lead if lead is not None else [island.get("name") or ""])
    words += [word for word, _ in counts.most_common(8)]
    seen = set()
    words = [word for word in words if word and not (word in seen or seen.add(word))]
    return "、".join(words) or "島"


def centred_units(vectors):
    """Rows centred on the seed mean (as profiles are) and scaled to length 1."""
    mean = dense_mean()
    rows = []
    for vector in np.asarray(vectors, dtype=float):
        vector = np.asarray(people.centre(vector, mean), dtype=float)
        norm = float(np.linalg.norm(vector))
        rows.append(vector / norm if norm else vector)
    return np.array(rows)


# A smaller island whose genre a bigger one already holds is that genre's
# neighbour when it stands within GENRE_NEAR world units of it ("南スポーツ島").
# Farther away a second スポーツ would send people to the wrong side of the map,
# so it keeps the name its own words give it (2026-10-17). On map v6 the two
# topics of each of 12 families stood within 169 of each other (the median
# distance between two topics was 406).
GENRE_NEAR = 250.0
DIRECTIONS = ("東", "南東", "南", "南西", "西", "北西", "北", "北東")   # screen y grows southwards

# How a genre is put to the encoder. A bare word ("料理") matched the right
# genre for 71% of 838 labelled posts, "趣味は料理" for 85% (2026-10-17).
GENRE_LABEL = "趣味は{}"
# An island's genre is the vote of its posts, and a post's genre the vote of the
# seeds standing nearest it on the map: a seed's genre is computed once from its
# vector, and a post was placed among the seeds nearest it in meaning, so its
# position alone tells (83% right). The island's own commonest words, encoded
# as one sentence, named 44% of the posts of v6's islands rightly; this, 61%.
GENRE_SEED_NEIGHBOURS = 15


def genre_vectors(model):
    if state.get("genre_vectors") is None:
        state["genre_vectors"] = np.asarray(
            model.encode([GENRE_LABEL.format(genre) for genre in ISLAND_GENRES], normalize_embeddings=True),
            dtype=float)
    return state["genre_vectors"]


def seed_genres(model):
    """(spots, genre index) of every seed, or None on a map not placed by its seeds."""
    if state.get("seed_genres") is None:
        placement = state.get("placement")
        if not placement:
            return None
        count = len(state["seed_map"]["seed"])
        dense = np.asarray(placement["vectors"][:count, :-SPARSE_DIM], dtype=float)
        dense /= np.clip(np.linalg.norm(dense, axis=1, keepdims=True), 1e-12, None)
        state["seed_genres"] = (np.asarray(placement["spots"][:count], dtype=float),
                                (dense @ centred_units(genre_vectors(model)).T).argmax(axis=1))
    return state["seed_genres"]


def located_genre(posts, model):
    """The genre index of each post with a position, by its nearest seeds; None without one."""
    if not any(post.get("x") is not None and post.get("y") is not None for post in posts):
        return {}
    seeds = seed_genres(model)
    if seeds is None:
        return {}
    spots, genres = seeds
    cache = state.setdefault("post_genres", {})
    todo = [post for post in posts if post.get("x") is not None and post.get("y") is not None
            and (post["id"], post["x"], post["y"]) not in cache]
    for start in range(0, len(todo), 256):
        chunk = todo[start:start + 256]
        xy = np.array([[float(post["x"]), float(post["y"])] for post in chunk])
        distance = ((xy[:, None, :] - spots[None, :, :]) ** 2).sum(axis=2)
        near = np.argpartition(distance, GENRE_SEED_NEIGHBOURS, axis=1)[:, :GENRE_SEED_NEIGHBOURS]
        for post, row in zip(chunk, near):
            votes = Counter(genres[row].tolist())
            cache[(post["id"], post["x"], post["y"])] = min(votes, key=lambda k: (-votes[k], k))
    if len(cache) > 50000:
        state["post_genres"] = {}
    return {post["id"]: cache.get((post["id"], post.get("x"), post.get("y"))) for post in posts}


def direction_from(holder, island):
    """Which way `island` lies from `holder`, in eight compass points."""
    angle = math.atan2(island["cy"] - holder["cy"], island["cx"] - holder["cx"])
    return DIRECTIONS[int(round(angle / (math.pi / 4))) % 8]


def name_by_genre(islands, posts_by_id):
    """Call each island by the activity genre closest to its words; word counts stay as the topics.

    Islands arrive biggest first. The first to want a genre gets it. A smaller
    island wanting a genre already held is named after it with the direction
    it lies in ("南スポーツ") when it is near the holder, and otherwise keeps its
    word-count name: until 2026-10-17 it took its next best free genre, which
    called a childcare island "IT" because 子育て was taken. Names stay unique
    and the same posts give the same names (ties go to the earlier genre). If
    the encoder is unavailable the islands keep their word-count names
    ('terms'); this never raises.
    """
    if not islands:
        return islands
    try:
        model = state["model"]
        genres = genre_vectors(model)
        posts = [posts_by_id[post_id] for island in islands for post_id in island.get("post_ids") or []
                 if post_id in posts_by_id]
        try:
            located = located_genre(posts, model)
        except Exception as error:   # a map or encoder that does not fit: words, as before
            if not state.get("located_warned"):
                state["located_warned"] = True
                _logger.warning("island genres by position unavailable, naming by words (%s)", type(error).__name__)
            located = {}
        bests = []
        for island in islands:
            votes = Counter(located[post_id] for post_id in island.get("post_ids") or []
                            if located.get(post_id) is not None)
            bests.append(min(votes, key=lambda k: (-votes[k], k)) if votes else None)
        # Islands whose posts have no position (or a map without seed placement):
        # by their words, as before.
        wordy = [k for k, best in enumerate(bests) if best is None]
        if wordy:
            texts = [island_text(islands[k], posts_by_id,
                                 [islands[k].get("name") or ""] + list(islands[k].get("topics") or []))
                     for k in wordy]
            scores = centred_units(model.encode(texts, normalize_embeddings=True)) @ centred_units(genres).T
            for k, row in zip(wordy, scores):
                bests[k] = min(range(len(ISLAND_GENRES)), key=lambda g: (-round(float(row[g]), 6), g))  # rounding: float noise must not flip ties
    except Exception as error:
        if not state.get("genre_warned"):
            state["genre_warned"] = True
            _logger.warning("island genres unavailable, keeping word-count names (%s)", type(error).__name__)
        return islands
    holders = {}   # genre -> the bigger island that has it
    used = set()   # every name given this run, plain or with a direction
    for island, best in zip(islands, bests):
        genre = ISLAND_GENRES[best]
        holder = holders.get(genre)
        if holder is None:
            holders[genre] = island
            name = genre
        else:
            if math.hypot(island["cx"] - holder["cx"], island["cy"] - holder["cy"]) > GENRE_NEAR:
                continue
            name = direction_from(holder, island) + genre
            if name in used:
                continue
        used.add(name)
        heading, topics = island.get("name") or "", list(island.get("topics") or [])
        island["topics"] = [word for word in [heading] + topics if word and word != genre][:len(topics) + 1]
        island["name"] = name
        island["label"] = f"{name}{island_namer.island_terrain(island)}"
        island["name_source"] = "genre"
    return islands


# Changes worth interrupting the people on the island for. Going quiet is in
# the log but tells nobody.
ISLAND_NOTIFY_KINDS = ("birth", "merge", "split", "rename", "tier", "landmark")


def notify_islands(events, states, now, community=None):
    """One 'island' notification per person per island per day at most.
    With `community` (members_only): only people who belong to it now are told, and the row
    says which community it is about."""
    store = state["store"]
    authors = {row["id"]: row.get("author_ids") or [] for row in states if row.get("active", True)}
    if community:
        members = set(store.community_member_ids(community))
        authors = {island: [person for person in people_ if person in members]
                   for island, people_ in authors.items()}
    recent = store.recent_notifications("island", now - timedelta(days=1))
    sent = Counter((row["recipient_id"], row.get("island_id")) for row in recent)
    # Somebody just told that a new resident moved in is not told the same island again today.
    moved_in = {(row["recipient_id"], row.get("island_id")) for row in recent
                if (row.get("payload") or {}).get("kind") == "resident" and row.get("island_id")}
    rows = []
    for event in events:
        if event["kind"] not in ISLAND_NOTIFY_KINDS:
            continue
        for person in authors.get(event["island_id"], []):
            key = (person, event["island_id"])
            if sent[key] >= ISLAND_NOTIFY_PER_DAY or key in moved_in:
                continue
            sent[key] += 1
            name = (event.get("after") or {}).get("name") or (event.get("before") or {}).get("name")
            rows.append({
                "recipient_id": person, "actor_id": None, "type": "island",
                "island_id": event["island_id"], "event_id": event["id"],
                "payload": {"kind": event["kind"], "cause": event["cause"], "name": name},
                **({"community_id": community} if community else {}),
            })
    store.insert_notifications(rows)
    return rows


def _plain_name(display_name):
    """A display name without a trailing 「さん」, so that 「さん」 can be added once."""
    name = display_name or "だれか"
    return name[:-2] if name.endswith("さん") and len(name) > 2 else name


def notify_resident(post_id, author_id, display_name, community=None, now=None, post_community=None):
    """Tell the other residents of an island that somebody with no post there before just moved in.

    Called right after a post is saved (not by the tracking step, which runs every ten minutes at
    the soonest). `community` is given with members_only (the islands are that community's);
    `post_community` is the post's own community either way. Only CURRENT members of that
    community are told and the row carries it, so the catch-up on its map finds it and nobody
    outside it ever reads the newcomer's name. Nobody blocked by, or blocking, the newcomer is told.
    Nothing is sent for the writer's second post on the island, for an island that this post
    created, past RESIDENT_NOTIFY_PER_DAY for one recipient and island, or past
    RESIDENT_NOTIFY_PER_PERSON_DAY for one recipient over all islands. Returns the rows written."""
    store = state["store"]
    now = now or datetime.now(timezone.utc)
    tagged = community or post_community
    entry = island_entry(post_id, community)
    if entry is None or (entry.get("author_counts") or {}).get(author_id) != 1:
        return []
    others = [person for person in entry.get("resident_ids") or [] if person != author_id]
    if tagged:
        members = set(store.community_member_ids(tagged))
        others = [person for person in others if person in members]
    if others:
        # Unreadable blocks: tell nobody rather than somebody who blocked the newcomer.
        blocked = store.blocked_with(author_id)
        others = [person for person in others if person not in blocked]
    if not others:
        return []
    island_id = None
    try:
        states = store.island_states(communities={community}) if community else store.island_states()
        _links, identity = island_tracking.match(states, [entry])
        if 0 in identity:
            island_id = states[identity[0]]["id"]
    except StoreError:
        pass
    label = "" if entry.get("name_pending") else (entry.get("label") or entry.get("name") or "")
    island_key = island_id or label or str(post_id)
    earlier = [row for row in store.recent_notifications("island", now - timedelta(days=1), recipient_ids=others)
               if (row.get("payload") or {}).get("kind") == "resident"]
    per_island = Counter((row["recipient_id"], row.get("island_id") or (row.get("payload") or {}).get("name"))
                         for row in earlier)
    per_person = Counter(row["recipient_id"] for row in earlier)
    rows = []
    for person in others:
        if (per_island[(person, island_key)] >= RESIDENT_NOTIFY_PER_DAY
                or per_person[person] >= RESIDENT_NOTIFY_PER_PERSON_DAY):
            continue
        rows.append({
            "recipient_id": person, "actor_id": author_id, "type": "island",
            "post_id": post_id, "island_id": island_id,
            "payload": {"kind": "resident", "name": label,
                        "cause": f"{_plain_name(display_name)}さんが引っ越してきました"},
            **({"community_id": tagged} if tagged else {}),
        })
    if rows:
        store.insert_notifications(rows)
    return rows


def name_islands_with_ai(named, previous, posts_by_id, now=None, new_only=False):
    """Genre names from Gemini for islands whose membership moved. Never raises.

    Runs inside the tracking step only (at most every ISLAND_RUN_MIN_SECONDS).
    No key, a timeout or a bad answer leaves the word-count name in place.
    """
    try:
        store = state["store"]
        if not getattr(store, "supports_island_names", True):
            return 0  # the migration is not in the database yet: no AI names
        namer = state.get("island_namer")
        if namer is None and "island_namer" not in state:
            namer = state["island_namer"] = island_namer.load_namer()
        if namer is None:
            return 0

        def people_names(island):
            ids = sorted({posts_by_id[pid]["author_id"] for pid in island.get("post_ids") or []
                          if pid in posts_by_id and posts_by_id[pid].get("author_id")})
            names = []
            for start in range(0, len(ids), 40):  # same chunk size as post_bodies
                try:
                    names += [row.get("display_name") or "" for row in store.list_accounts(ids[start:start + 40])]
                except Exception as error:
                    _logger.warning("island naming: display names unavailable (%s)", type(error).__name__)
            return names

        def bodies(ids):
            found = store.post_bodies(ids)
            return [found[pid] for pid in ids if pid in found]

        def author_count(island):
            return len({posts_by_id[pid]["author_id"] for pid in island.get("post_ids") or []
                        if pid in posts_by_id and posts_by_id[pid].get("author_id")})

        return island_namer.name_islands(named, previous, bodies, namer, people_names,
                                         now=now, author_count=author_count, new_only=new_only)
    except Exception:
        _logger.exception("island naming failed")
        return 0


def track_islands(now=None, community=None, new_only=False):
    """One tracking step: match the live islands to the stored ones, save, notify.

    The first step ever records every island as born but tells nobody: those
    islands were there before anybody was watching.

    With members_only on, the step runs once PER COMMUNITY: the islands are made from that
    community's posts, matched only against that community's saved islands (so an island of A can
    never inherit the id or name of one of B), saved and notified with its community_id. The
    result is the sum of the steps.
    """
    store = state["store"]
    now = now or datetime.now(timezone.utc)
    if community is None and _members_flag():
        total = {"states": [], "events": [], "notifications": [], "ids": {}}
        for each in store.community_ids():
            step = track_islands(now=now, community=each, new_only=new_only)
            for key in ("states", "events", "notifications"):
                total[key].extend(step[key])
        return total
    # Work on a copy: the cached islands are read by requests while this runs.
    named = reveal_genre_names(copy.deepcopy(live_islands(force=True, **scoped(community))))
    posts_by_id = {post["id"]: post for post in store.list_terms(limit=NAMING_POST_LIMIT, **scoped(community))}
    events = store.interaction_events(since=None)
    if community:
        events = [event for event in events if event.get("post_id") in posts_by_id]
        previous = store.island_states(communities={community})
    else:
        previous = store.island_states()
    island_namer.overlay(named, previous)  # idempotent; live_islands already did it
    name_islands_with_ai(named, previous, posts_by_id, now=now, new_only=new_only)
    try:
        ranker = landmark_ranker(named, posts_by_id)
    except Exception:  # an embedding outage costs the landmarks, not the step
        _logger.exception("landmark ranking failed")
        ranker = None
    result = island_tracking.update(previous, named, posts_by_id, events, now=now, rank_landmarks=ranker)
    if community:
        for row in result["states"] + result["events"]:
            row["community_id"] = community
    store.save_island_states(result["states"])
    store.add_island_events(result["events"])
    result["notifications"] = (notify_islands(result["events"], result["states"], now,
                                              **({"community": community} if community else {}))
                               if previous else [])
    # No cache swap here: the next live_islands() lays the saved names over its own
    # (fresh) islands, and swapping in this older copy could overwrite a newer cache.
    return result


def maybe_track_islands():
    """Start a tracking step in the background if this caller wins the claim.

    While some island waits for its first AI name the claim interval is short
    (ISLAND_RUN_PENDING_SECONDS) and the step only names such islands, unless a full
    step has not run for ISLAND_RUN_MIN_SECONDS."""
    if not ISLAND_AUTO_TRACK or not _island_run_lock.acquire(blocking=False):
        return False
    waiting = any((state.get("naming_pending") or {}).values())
    new_only = waiting and time.time() - state.get("full_track_at", 0) < ISLAND_RUN_MIN_SECONDS
    try:
        claimed = state["store"].claim_island_run(ISLAND_RUN_PENDING_SECONDS if waiting else ISLAND_RUN_MIN_SECONDS)
    except StoreError:
        claimed = False
    if not claimed:
        _island_run_lock.release()
        return False

    def work():
        try:
            if not new_only:
                state["full_track_at"] = time.time()
            track_islands(new_only=new_only)
        except Exception:
            _logger.exception("island tracking failed")
        invalidate_islands()  # the next request shows the names just made
        try:
            if QUIET_POST_ENABLED:  # off by default: the "resident" notice replaced it
                notify_quiet_posts()
        except Exception:
            _logger.exception("quiet posts failed")
        finally:
            _island_run_lock.release()

    threading.Thread(target=work, name="island-tracking", daemon=True).start()
    return True


def notify_quiet_posts(now=None, community=None):
    """Q34: show posts nobody has answered to a few people nearby, in the app only.

    Runs with the island step, so at most every ISLAND_RUN_MIN_SECONDS.

    With members_only on it runs once per community: the quiet post, the islands that decide who
    is near and the people told all come from that one community, only people who still belong
    to it are told, and the row says which community it is about.
    """
    store = state["store"]
    now = now or datetime.now(timezone.utc)
    if community is None and _members_flag():
        rows = []
        for each in store.community_ids():
            rows.extend(notify_quiet_posts(now=now, community=each))
        return rows
    earlier = store.recent_notifications("quiet_post", now - timedelta(days=QUIET_POST_MAX_DAYS + 1))
    found = quiet.candidates(store.list_terms(limit=NAMING_POST_LIMIT, **scoped(community)),
                             live_islands(**scoped(community)), now,
                             already={row.get("post_id") for row in earlier})
    if community:
        members = set(store.community_member_ids(community))
        found = [dict(item, people=[person for person in item["people"] if person in members])
                 for item in found]
        found = [item for item in found if item["people"]]
    if not found:
        return []
    everyone = {person for item in found for person in item["people"]}
    visitors = store.recent_visitors(everyone, now - timedelta(days=QUIET_POST_VISIT_DAYS))
    day_ago = now - timedelta(days=1)
    told = [row["recipient_id"] for row in earlier if notices.parse_time(row["created_at"]) >= day_ago]
    rows = quiet.choose(found, visitors, told)
    if community:
        rows = [dict(row, community_id=community) for row in rows]
    store.insert_notifications(rows)
    return rows


# --------------------------------------------------------------------------
# Web Push: outside the app, a few seconds after the row is written
# --------------------------------------------------------------------------
#
# Every insert into notifications pokes POST /api/push/dispatch (a pg_net
# trigger in a deployment, MemoryStore.on_notify locally). The poke carries
# nothing: the dispatcher claims the rows nobody has pushed yet, so a forged
# poke can only send what was already due, early.

# What the lock screen says. No message text: the screen may be on a desk.
PUSH_TEXT = {
    "like": "あなたの投稿に「いいね」しました。",
    "help": "あなたの投稿に「手伝えるかも」と反応しました。",
    "join": "あなたの投稿に「参加」と反応しました。",
    "comment": "あなたの投稿にメッセージを送りました。",
    "reply": "あなたのメッセージに返信しました。",
    "connection": "初めてやりとりしました。地図に線が引かれます。",
    "similar": "話題や目標が近い人が参加しました。",
    "island": "島が変わりました。",
    # 2026-10-26. talk_wish names nobody (the row has no actor); dm never carries the text.
    "talk_wish": f"誰かが、あなたと{TALK_LABEL}と言っています",
    "talk_match": "{name}さんと、お互いに『" + TALK_LABEL + "』でした。DMが開きました",
    "dm": "{name}さんからメッセージが届きました",
    # 2026-10-29. Normally the row's own payload.reason is read out; this is the fallback.
    "match": "あなたの投稿とつながりそうな投稿が見つかりました。",
}
PUSH_GROUP_TEXT = "あなたの投稿に反応しました。"


def push_keys():
    """(public, private) VAPID pair, made and stored the first time it is needed.

    None when the stored pair does not fit together: that is somebody's edit to
    fix by hand, and overwriting it would cut off every browser subscribed to it.
    """
    store = state["store"]
    with _push_lock:
        if _push_keys["store"] is store and _push_keys["pair"]:
            return _push_keys["pair"]
    row = store.get_push_config()
    if not row.get("vapid_private"):
        public, private = webpush.new_keys()
        row = store.save_push_keys(public, private)
    public, private = row.get("vapid_public"), row.get("vapid_private")
    if not (public and private and webpush.keys_match(public, private)):
        _logger.error("push_config holds a VAPID pair that does not match; push is off")
        return None
    with _push_lock:
        _push_keys.update({"store": store, "pair": (public, private),
                           "dispatch_url": row.get("dispatch_url")})
    return public, private


def push_subject():
    """The VAPID contact: PUSH_SUBJECT, else this deployment's own address."""
    configured = os.environ.get("PUSH_SUBJECT", "").strip()
    if configured:
        return configured
    parts = urlsplit(_push_keys.get("dispatch_url") or "")
    if parts.scheme == "https" and parts.netloc:
        return f"https://{parts.netloc}"
    return "https://localhost"


def push_message(entry, hashed_tag=False):
    """One notification_feed() entry as the text a lock screen shows.

    hashed_tag (members_only): the tag that groups reactions to one post is a hash, so the id of a
    post is not handed to the device's notification layer."""
    payload = entry.get("payload") or {}
    url = PUSH_URL
    if entry["type"] == "island" and payload.get("kind") == "resident":
        first = (entry.get("actors") or [None])[0] or {}
        who = _plain_name(first.get("display_name")) if first.get("display_name") else "だれか"
        title = "新しい住人"
        body = f"{payload.get('name') or '島'}に{who}さんが引っ越してきました"
        url = PUSH_URL_RESIDENT
    elif entry["type"] == "island":
        title = f"島「{payload['name']}」" if payload.get("name") else "島"
        body = f"{payload['cause']}。" if payload.get("cause") else PUSH_TEXT["island"]
    elif entry["type"] == "talk_wish":
        # Never reads the actors: whoever pressed is not in the row, and must not get in.
        title = "だれか"
        body = PUSH_TEXT["talk_wish"]
    elif entry["type"] == "match":
        first = (entry["actors"][0] if entry["actors"] else None) or {}
        title = f"{_plain_name(first['display_name'])}さん" if first.get("display_name") else "だれか"
        body = payload.get("reason") or PUSH_TEXT["match"]
        if entry.get("post_id"):
            url = f"/#/map?post={entry['post_id']}"
    elif entry["type"] in ("talk_match", "dm"):
        first = (entry["actors"][0] if entry["actors"] else None) or {}
        title = first.get("display_name") or "だれか"
        body = PUSH_TEXT[entry["type"]].format(name=title[:-2] if title.endswith("さん") and len(title) > 2 else title)
    else:
        first = (entry["actors"][0] if entry["actors"] else None) or {}
        title = first.get("display_name") or "だれか"
        if entry["others"]:
            title = f"{title} ほか{entry['others']}人"
        body = PUSH_GROUP_TEXT if entry["others"] else PUSH_TEXT.get(entry["type"], PUSH_GROUP_TEXT)
    # Reactions to one post share a tag, so "A ほか2人" replaces "A" on the
    # device instead of stacking. Everything else stands alone.
    if entry["category"] == "reaction" and entry.get("post_id") and entry["type"] != "match":
        tag = f"reaction-{entry['post_id']}"
        if hashed_tag:
            tag = webpush.topic_for(tag)
    else:
        tag = f"{entry['type']}-{entry['id']}"
    return {"title": title, "body": body, "tag": tag, "url": url,
            "kind": entry["category"], "at": entry["created_at"]}


# Notifications that are about one community even when they name no post.
_COMMUNITY_NOTICE_TYPES = ("island", "quiet_post", "similar")


def pushes_still_readable(rows):
    """members_only: keep only the rows whose recipient still belongs to the community the row is
    about, checked NOW (the row may have been written before they left). A row about a post takes
    the community of that post; an island / quiet_post / similar row must carry its own community
    (one without is dropped); a talk or DM row names no community and stays."""
    store = state["store"]
    memberships, posts, kept = {}, {}, []
    for row in rows:
        recipient = row["recipient_id"]
        if recipient not in memberships:
            memberships[recipient] = {str(c) for c in store.viewer_communities(recipient)}
        community = row.get("community_id")
        if row.get("post_id"):
            if row["post_id"] not in posts:
                posts[row["post_id"]] = store.get_post(row["post_id"])
            post = posts[row["post_id"]]
            if not post:
                continue
            if community and str(community) != str(post.get("community_id")):
                continue
            community = post.get("community_id")
            if not community:
                continue
        elif row["type"] in _COMMUNITY_NOTICE_TYPES and not community:
            continue
        if community and str(community) not in memberships[recipient]:
            continue
        kept.append(row)
    return kept


def dispatch_pushes(now=None, client=None):
    """Push every notification not pushed yet. Returns a Counter of outcomes.

    Skipped: types that stay in the app (NEVER_PUSHED), rows older than
    PUSH_FRESH_MINUTES (a server that slept should not wake everybody with old
    news), people with the app on screen (the band shows it there), and kinds
    switched off for push.
    """
    store = state["store"]
    now = now or datetime.now(timezone.utc)
    fresh = now - timedelta(minutes=PUSH_FRESH_MINUTES)
    rows = [row for row in store.claim_pending_pushes()
            if row["type"] not in NEVER_PUSHED and notices.parse_time(row["created_at"]) >= fresh]
    tally = Counter()
    members = members_only_quiet()
    if rows and members:
        before = len(rows)
        rows = pushes_still_readable(rows)
        tally["dropped_not_member"] += before - len(rows)
    if not rows:
        return tally
    recipients = {row["recipient_id"] for row in rows}
    recipients -= store.active_accounts(recipients)
    settings = store.notification_settings_for(recipients)
    rows = [row for row in rows if row["recipient_id"] in recipients and notices.allows(
        notices.merge_settings(settings.get(row["recipient_id"])), row["type"], "push")]
    targets = defaultdict(list)
    for subscription in store.push_subscriptions({row["recipient_id"] for row in rows}):
        targets[subscription["account_id"]].append(subscription)
    claimed = defaultdict(set)
    for row in rows:
        if targets.get(row["recipient_id"]):
            claimed[row["recipient_id"]].add(row["id"])
    if not claimed:
        return tally
    keys = push_keys()
    if keys is None:
        tally["no_keys"] += sum(len(ids) for ids in claimed.values())
        return tally
    subject = push_subject()
    own_client = client is None
    client = client or httpx.Client()
    try:
        for recipient, ids in claimed.items():
            # The feed is grouped the way the app lists it, so the push says
            # what the list will say when it is opened.
            feed = notices.group_feed(store.list_notifications(recipient, limit=100), limit=100)
            messages = [push_message(entry, hashed_tag=members)
                        for entry in reversed(feed) if ids.intersection(entry["ids"])]
            for subscription in targets[recipient]:
                for message in messages:
                    outcome = webpush.send(
                        subscription, message, public_b64u=keys[0], private_b64u=keys[1],
                        subject=subject, ttl=PUSH_TTL_SECONDS,
                        topic=webpush.topic_for(message["tag"]), client=client)
                    tally[outcome] += 1
                    if outcome == "gone":
                        store.delete_push_subscription(subscription["endpoint"])
                        break
    finally:
        if own_client:
            client.close()
    return tally


def _push_loop():
    while True:
        started = time.monotonic()
        try:
            dispatch_pushes()
        except Exception:
            _logger.exception("push dispatch failed")
        with _push_lock:
            if not _push_state["again"]:
                _push_state["running"] = False
                return
            _push_state["again"] = False
        time.sleep(max(0.0, PUSH_MIN_GAP_SECONDS - (time.monotonic() - started)))


def poke_push_dispatch():
    """Wake the dispatcher. Never blocks: MemoryStore calls it holding its lock."""
    if not PUSH_AUTO:
        return False
    with _push_lock:
        if _push_state["running"]:
            _push_state["again"] = True
            return False
        _push_state["running"] = True
    threading.Thread(target=_push_loop, name="push-dispatch", daemon=True).start()
    return True


def with_tracked_state(payload, community=None):
    """Live islands with the id, tier and landmarks of the island they continue.
    With `community`, only that community's saved islands can be continued."""
    try:
        states = (state["store"].island_states(communities={community}) if community
                  else state["store"].island_states())
    except StoreError:
        return [public_island(island) for island in payload]
    _links, identity = island_tracking.match(states, payload)
    out = []
    for index, island in enumerate(payload):
        row = public_island(island)
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


def neighbors_for(post_id, terms, limit, community=None):
    """Ranked neighbours with shared words, straight off the ANN index.

    Ranking is by the 448-dim cosine and never by distance on the map. The map
    is a 2-D shadow of that space and this build's own gate records that only
    34% of true neighbours survive the projection.
    """
    try:
        if community and members_only_quiet():
            # members_only: the database function itself only looks inside the community.
            ranked = state["store"].nearest_posts(post_id, limit, community=community)
        elif community:
            # Only people on the same community's map. The index knows nothing of communities, so
            # ask for more and keep the ones that belong.
            of_community = state["store"].post_communities()
            ranked = [pair for pair in state["store"].nearest_posts(post_id, min(max(limit * 6, 60), 300))
                      if of_community.get(pair[0]) == community][:limit]
        else:
            ranked = state["store"].nearest_posts(post_id, limit)
    except (StoreError, ValueError):
        return []
    return neighbor_rows(ranked, terms, community=community if members_only_quiet() else None)


def neighbor_rows(ranked, terms, community=None):
    """[(post_id, cosine)] -> the rows the reveal and the orbit print.
    With `community` (members_only), a post of any other community is dropped as well."""
    store = state["store"]
    out = []
    for other_id, cosine in ranked:
        try:
            other = store.get_post(other_id)
        except StoreError:
            continue
        if not other:
            continue
        if community and other.get("community_id") != community:
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
                ("line", os.environ.get("KOTOBA_OAUTH_LINE") == "1"),
                ("apple", os.environ.get("KOTOBA_OAUTH_APPLE") == "1"),
            ) if flag
        ],
        "world": {"min": MAP_MIN, "max": MAP_MAX, "seed_bounds": state["seed_bounds"]},
        # members_only: the reach factor follows the number of posts on the whole service, so a
        # signed-out caller gets a constant (a community's own factor comes, member-gated, with /api/islands).
        "energy": {**energy_constants(), "radius_factor": (
            1.0 if members_only_quiet() else current_reach_factor())},
        "tags": list(TAGS),
        # Q45: the tag that says "話しかけていいよ". Named so the browser can
        # give it its own switch instead of finding it by its wording.
        "open_tag": TAGS[0],
        "weekly_prompt": weekly_prompt(),
        # 2026-10-20: prompts that go away for a person once they posted with them
        # (the browser decides from the `prompt` of that person's posts).
        "extra_prompts": [dict(item) for item in EXTRA_PROMPTS],
        "post_starters": [dict(item) for item in POST_STARTERS],
        "example_posts": list(EXAMPLE_POSTS),
        # post_extras: the database can keep the prompt / sign-up deadline / capacity.
        # False on a production database the 2026-10-20 SQL has not reached yet.
        # members_only: whether community posts are readable by their members only (the screens then
        # send the session on every read and show a notice instead of a map to anybody outside).
        # share: a post can be put on other communities' maps too (posts.share_group, 2026-10-29).
        "features": {"post_extras": post_extras_on(), "talk": talk_on(),
                     "communities": communities_on(), "members_only": members_only_quiet(),
                     "share": share_on()},
        # 2026-10-26: new accounts need an invite link (only meaningful with features.communities).
        "invite_only": invite_only_on(),
        # 2026-10-26: 「話してみたい」のボタンの名前。画面は features.talk が true のときだけ使う。
        "talk": {"label": TALK_LABEL},
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
        "push": {"public_key": push_public_key(), "presence_seconds": PRESENCE_PING_SECONDS,
                 "presence_hold": PRESENCE_HOLD_SECONDS},
    }


def push_public_key():
    """The VAPID public key browsers subscribe with, or None when push is off."""
    try:
        pair = push_keys()
    except StoreError:
        return None
    return pair[0] if pair else None


@app.get("/api/health")
def health():
    # The keep-alive ping hits this route, and a Supabase free project suspends
    # itself after 7 idle days. Touching the database keeps both halves of the
    # deployment awake with one request. A store that is down must not take
    # health down with it - the answer is still useful without the count.
    try:
        posts = state["store"].count_posts(everything=True)
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
    # The island names need the 2026-10-12 columns. Without them a release is not
    # ready, so the CI check (scripts/verify_release.py --phase ready) stops it.
    # Only a Supabase database can lack them; the local store always has them.
    not_ready = []
    if not store_ok:
        not_ready.append("store_unreachable")
    if not compatible:
        not_ready.append("artifact_version_mismatch")
    if runtime["maintenance"]:
        not_ready.append("maintenance")
    island_names_ok = True
    if store_ok:
        try:
            island_names_ok = bool(state["store"].island_names_ready())
        except StoreError:
            island_names_ok = False
        if not island_names_ok:
            not_ready.append("islands_state.name_source column missing (run migration 20261012000000)")
    # The 2026-10-20 post columns are NOT part of ready: without them the code
    # simply keeps the prompt / sign-up features off, so production stays up.
    try:
        post_extras_ok = bool(state["store"].post_extras_ready()) if store_ok else False
    except StoreError:
        post_extras_ok = False
    try:
        talk_ok = bool(state["store"].talk_ready()) if store_ok else False
    except StoreError:
        talk_ok = False
    try:
        communities_ok = bool(state["store"].communities_ready()) if store_ok else False
    except StoreError:
        communities_ok = False
    return {
        "ok": True,
        "seed_count": len(state["seed_coords"]),
        "regions": len(state["islands"]),
        "store": state["store"].backend,
        "store_ok": store_ok,
        # members_only: how many posts the service holds is not for visitors (nor is it a number the
        # health check needs: store_ok already says the database answered).
        "posts": None if members_only_quiet() else posts,
        "model_version": state["seed_map"]["meta"]["model_version"],
        "embedding": state["manifest"]["embedding"],
        "artifact_version": state["manifest"]["artifact_version"],
        "artifact_compatible": compatible,
        "maintenance": runtime["maintenance"],
        "active_map_version": runtime["active_version"],
        "island_names_ready": island_names_ok,
        "post_extras_ready": post_extras_ok,
        "talk_ready": talk_ok,
        "communities_ready": communities_ok,
        "ready": store_ok and compatible and not runtime["maintenance"] and island_names_ok,
        "not_ready_reasons": not_ready,
    }


@app.get("/api/islands")
def islands(response: Response, request: Request, community: str = ""):
    if members_only_on():
        # Islands are made from, and shown to, the members of ONE community.
        user_id = current_user(request)
        cid = community_param(user_id, community)
        maybe_track_islands()
        try:
            payload = with_tracked_state(live_islands(community=cid), community=cid)
        except StoreError:
            raise HTTPException(status_code=503, detail="読み込みに失敗しました。")
        response.headers["Cache-Control"] = "private, no-store"
        return {"islands": payload, "radius_factor": current_reach_factor(cid)}
    maybe_track_islands()
    payload = with_tracked_state(live_islands())
    # Everyone looking at the map wants the same answer, and it changes on a
    # timer rather than per viewer. Worth a CDN hop if one is ever put in front.
    response.headers["Cache-Control"] = "public, max-age=30"
    # The browser's ground follows the map's reach factor, which moves as the map
    # fills: a page open for hours picks it up here (web/js/config.js).
    return {"islands": payload, "radius_factor": current_reach_factor()}


@app.get("/api/connections")
def connections(response: Response, request: Request, person: str = "", fresh: str = "",
                community: str = ""):
    """Lines between people. Public: a line is visible to everybody, not just the two.

    `fresh` comes from somebody who just reacted or wrote. In production that
    write goes to the database directly, so this server's cache cannot know of
    it: recount now (at most once every few seconds, whoever asks).

    members_only: login required. `community` must be one the caller belongs to; without it, the
    lines of ALL the caller's communities (there is no all-posts variant any more), and with
    `person` only the lines that run on those maps.
    """
    if members_only_on():
        user_id = current_user(request)
        scope = {community_param(user_id, community)} if community else viewer_communities(user_id)
        try:
            rows = lines_of_communities(scope, force=bool(fresh) and fresh_lines_due())
        except StoreError:
            raise HTTPException(status_code=503, detail="読み込みに失敗しました。")
        if person:
            rows = [row for row in rows if person in (row["a"], row["b"])]
        response.headers["Cache-Control"] = "private, no-store"
        return {"connections": rows, "since": CONNECTIONS_SINCE}
    scope = None
    if community and communities_on():
        try:
            scope = str(uuid.UUID(community))
        except ValueError:
            raise HTTPException(status_code=422, detail="コミュニティが不正です。")
    try:
        rows = connection_lines(force=bool(fresh) and fresh_lines_due(), community=scope)
    except StoreError:
        raise HTTPException(status_code=503, detail="読み込みに失敗しました。")
    if person:
        rows = [row for row in rows if person in (row["a"], row["b"])]
    # Short enough that the 15 s poll never reads a stale copy from the browser.
    response.headers["Cache-Control"] = "no-store" if fresh else f"public, max-age={CONNECTION_BROWSER_SECONDS}"
    return {"connections": rows, "since": CONNECTIONS_SINCE}


@app.get("/api/similar-people")
def similar_people_route(request: Request, account: str = ""):
    """The people most like `account` (or the signed-in person), best first.

    members_only: login required; you can ask about yourself only (`account` is ignored), and the
    candidates, their centroids and the places they stand on come from the communities you are in."""
    scope = None
    if members_only_on():
        account = current_user(request)
        scope = viewer_communities(account)
        if not scope:
            return {"people": []}
    else:
        account = account or current_user(request)
    store = state["store"]
    try:
        index = people_index(scope)
        ranked = similar_people(account, index=index)
        # Where each of them stands on the map: the dotted line goes there.
        if not ranked:
            posts = []
        elif scope is None:
            posts = store.list_terms(limit=NAMING_POST_LIMIT)
        else:
            posts = [post for community in sorted(scope)
                     for post in store.list_terms(limit=NAMING_POST_LIMIT, community=community)]
        _, best = home_posts(posts)
        places = islands_by_author(posts, communities=scope) if ranked else {}
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
    scope = None
    if members_only_on():
        # Login required, and `?viewer=` is ignored: the viewer is whoever the token says. What the
        # card shows of the person's posts, island and lines comes only from the communities the
        # VIEWER is in (their own card: all their own posts). A person who shares none with the
        # viewer is shown as a profile alone, with no posts.
        viewer = current_user(request)
        scope = viewer_communities(viewer)
    else:
        viewer = optional_user(request) or viewer or None
    store = state["store"]
    try:
        person = store.get_account(person_id)
        if not person:
            raise HTTPException(status_code=404, detail="見つかりませんでした。")
        own = store.posts_by_author(person_id)
        if scope is not None and person_id != viewer:
            own = [post for post in own if str(post.get("community_id") or "") in scope]
        if scope is None:
            places = islands_by_author()
            rows = [row for row in connection_lines() if person_id in (row["a"], row["b"])]
        else:
            places = islands_by_author(communities=scope)
            rows = [row for row in lines_of_communities(scope) if person_id in (row["a"], row["b"])]
        partner_ids = [row["b"] if row["a"] == person_id else row["a"] for row in rows]
        shown = partner_ids[:PERSON_CARD_CONNECTIONS]
        partners = {row["id"]: row for row in store.list_accounts(shown)}
        intro = None
        if viewer and viewer != person_id:
            intro = introduce(viewer, person_id, people_index(scope), places)
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
            "id", "body", "tags", "x", "y", "created_at", "like_count", "comment_count")} if latest else None,
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
def changes(request: Request, since: str = "", limit: int = 50, community: str = ""):
    """What happened to the islands: place, cause and the counts before and after.
    members_only: login required, and only the events of the caller's communities."""
    scope = None
    if members_only_on():
        user_id = current_user(request)
        scope = {community_param(user_id, community)} if community else viewer_communities(user_id)
    maybe_track_islands()
    limit = max(1, min(int(limit), 200))
    try:
        rows = state["store"].list_island_events(
            since=_parse_since(since), limit=limit,
            **({} if scope is None else {"communities": scope}))
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
    scope = viewer_communities(user_id) if members_only_on() else None
    maybe_track_islands()
    try:
        previous = store.touch_last_seen(user_id)
        start = previous or (datetime.now(timezone.utc) - timedelta(days=14)).isoformat()
        # What led up to the changes: interactions from a while before them.
        lead_in = (notices.parse_time(start) - timedelta(days=14)).isoformat()
        if scope is None:
            rows = store.list_island_events(since=start, limit=500)
            islands_by_id = {row["id"]: row for row in store.island_states(active_only=False)}
            friends = lines.partners(connection_lines(), user_id)
            events = store.interaction_events(since=lead_in)
        else:
            # members_only: only the communities the caller is in, in every one of the four reads.
            rows = store.list_island_events(since=start, limit=500, communities=scope)
            islands_by_id = {row["id"]: row for row in store.island_states(
                active_only=False, communities=scope)}
            friends = lines.partners(lines_of_communities(scope), user_id)
            visible = {post["id"] for community in scope
                       for post in store.list_terms(limit=NAMING_POST_LIMIT, community=community)}
            events = [event for event in store.interaction_events(since=lead_in)
                      if event.get("post_id") in visible]
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
    """Push and in-app switches for each of the three kinds (reply, reaction, island). No row means on.

    `quiet_post` (top level, read-only, worked out here): whether "a quiet post
    nearby" shows in the app. It is the island in_app switch, and stays false for
    somebody who had switched the retired similar category's in_app off. Quiet
    posts are never pushed.
    """
    user_id = current_user(request)
    try:
        rows = state["store"].get_notification_settings(user_id)
    except StoreError:
        raise HTTPException(status_code=503, detail="読み込みに失敗しました。")
    merged = notices.merge_settings(rows)
    return {"settings": merged, "categories": list(NOTIFICATION_CATEGORIES),
            "quiet_post": merged.quiet_post}


@app.put("/api/notification-settings")
def put_notification_settings(payload: NotificationSettings, request: Request):
    user_id = current_user(request)
    rows = [item.model_dump() for item in payload.settings]
    # Old screens still send connection / similar: accept and ignore them.
    rows = [row for row in rows if row["category"] not in LEGACY_NOTIFICATION_CATEGORIES]
    unknown = [row["category"] for row in rows if row["category"] not in NOTIFICATION_CATEGORIES]
    if unknown:
        raise HTTPException(status_code=422, detail=f"知らない通知の種類です: {', '.join(unknown)}")
    try:
        saved = state["store"].put_notification_settings(user_id, rows)
    except StoreError:
        raise HTTPException(status_code=503, detail="保存に失敗しました。もう一度お試しください。")
    merged = notices.merge_settings(saved)
    return {"settings": merged, "categories": list(NOTIFICATION_CATEGORIES),
            "quiet_post": merged.quiet_post}


def _decoded(value):
    try:
        return webpush.unb64u(value)
    except ValueError:
        return b""


@app.post("/api/push/subscribe")
def push_subscribe(payload: PushSubscribe, request: Request):
    """Remember this browser as somewhere to push to.

    Only the server writes subscriptions: it is the one that will POST to the
    endpoint, so it checks the endpoint belongs to a known push service first.
    """
    user_id = current_user(request)
    key = _decoded(payload.keys.p256dh)
    if (not webpush.allowed_endpoint(payload.endpoint) or len(key) != 65 or key[:1] != b"\x04"
            or len(_decoded(payload.keys.auth)) != 16):
        raise HTTPException(status_code=422, detail="この端末の通知の登録は使えません。")
    agent = (request.headers.get("user-agent") or "")[:300] or None
    try:
        state["store"].save_push_subscription(user_id, payload.endpoint, payload.keys.p256dh,
                                              payload.keys.auth, agent)
    except StoreError:
        raise HTTPException(status_code=503, detail="通知の登録に失敗しました。もう一度お試しください。")
    return {"ok": True}


@app.post("/api/push/unsubscribe")
def push_unsubscribe(payload: PushUnsubscribe, request: Request):
    user_id = current_user(request)
    try:
        removed = state["store"].delete_push_subscription(payload.endpoint, user_id)
    except StoreError:
        raise HTTPException(status_code=503, detail="通知の解除に失敗しました。もう一度お試しください。")
    return {"removed": removed}


@app.post("/api/push/dispatch", status_code=202)
def push_dispatch():
    """The database's poke after an insert into notifications. Carries nothing."""
    poke_push_dispatch()
    return {"ok": True}


@app.get("/api/map/bounds")
def map_bounds(request: Request, community: str = ""):
    from core.energy import post_radius
    cid = None
    if members_only_on():
        cid = community_param(current_user(request), community)
    try:
        posts = state["store"].terrain_posts(**scoped(cid))
    except StoreError as exc:
        raise HTTPException(503, "地図の範囲を読み込めませんでした。") from exc
    if not posts:
        return {"bounds": None, "count": 0}
    factor = current_reach_factor(cid)
    return {"bounds": [min(p["x"] - post_radius(p, factor) for p in posts),
                       min(p["y"] - post_radius(p, factor) for p in posts),
                       max(p["x"] + post_radius(p, factor) for p in posts),
                       max(p["y"] + post_radius(p, factor) for p in posts)], "count": len(posts)}


@app.get("/api/terrain")
def terrain(request: Request, min_x: float, min_y: float, max_x: float, max_y: float,
            query: str = "", tags: str = "", community: str = ""):
    from core.terrain import energy_grid
    cid = None
    if members_only_on():
        cid = community_param(current_user(request), community)
    bounds = [min_x, min_y, max_x, max_y]
    if not all(np.isfinite(bounds)) or not (min_x < max_x and min_y < max_y):
        raise HTTPException(422, "地図の範囲が不正です。")
    if max_x - min_x > 100000 or max_y - min_y > 100000 or len(query) > 140:
        raise HTTPException(422, "地図の範囲が大きすぎます。")
    selected = [tag for tag in tags.split(',') if tag]
    if any(tag not in TAGS for tag in selected):
        raise HTTPException(422, "タグが不正です。")
    try:
        posts = state["store"].terrain_posts(**scoped(cid))
    except StoreError:
        raise HTTPException(503, "地形を読み込めませんでした。")
    needle = query.lower()
    posts = [p for p in posts if
             (not needle or needle in (p.get('body', '') + ' ' + p.get('display_name', '')).lower())
             and (not selected or any(tag in p.get('tags', []) for tag in selected))]
    return energy_grid(posts, bounds, factor=current_reach_factor(cid))


@app.post("/api/posts")
def create_post(payload: PostCreate, request: Request):
    """The one write that cannot happen anywhere else.

    x/y/cluster_id/vec are the frozen encoder's output. If a client could send
    them, anybody could put themselves in the middle of any island they liked,
    and the only claim this app makes - that where you are means something -
    would be false.
    """
    user_id = current_user(request)
    members = members_only_on()
    body = clean_body(payload.body)
    request_key = request.headers.get("Idempotency-Key")
    stable_id = None
    if request_key:
        try:
            uuid.UUID(request_key)
        except ValueError:
            raise HTTPException(422, "再試行キーが不正です。")
        canon = {"body": body, "tags": clean_tags(payload.tags),
                 "motivation": clean_motivation(payload.motivation), "image_path": payload.image_path or None}
        # Only when given, so a retry key made before 2026-10-20 still finds its post.
        for name in ("prompt", "recruit_deadline", "recruit_capacity", "community_id"):
            if getattr(payload, name) is not None:
                canon[name] = getattr(payload, name)
        canonical = json.dumps(canon, sort_keys=True, ensure_ascii=False, default=str)
        stable_id = str(uuid.uuid5(uuid.NAMESPACE_URL, user_id + ':' + request_key + ':' + canonical))
        try:
            existing = state["store"].get_post(stable_id)
        except StoreError:
            raise HTTPException(503, "投稿の保存状況を確認できませんでした。")
        if existing:
            return {**existing, "island": island_for_viewer(existing, user_id), "neighbors": []}
    if not check_rate_limit(user_id):
        raise HTTPException(status_code=429, detail="少し時間をおいてからお試しください。")

    store = state["store"]
    try:
        account = store.get_account(user_id)
    except StoreError:
        raise HTTPException(status_code=503, detail="読み込みに失敗しました。もう一度お試しください。")
    if not account or not account.get("display_name"):
        raise HTTPException(status_code=409, detail="先にプロフィールを作成してください。")

    tags = clean_tags(payload.tags)
    extras = extras_for_new_post(payload, tags) if post_extras_on() else {}
    # The community: only members post to it (checked here, because the server is the only
    # writer of posts). Not sent, or communities not switched on yet: a post with none, as before.
    community_id = None
    if members:
        # members_only: every post belongs to a community the author is in (the only one when
        # there is just one; a 422 when there are several and none was named; 403 when none).
        community_id = only_community_of(user_id, payload.community_id)
        extras = {**extras, "community_id": community_id}
    elif communities_on() and payload.community_id:
        try:
            community_id = str(uuid.UUID(payload.community_id))
        except ValueError:
            raise HTTPException(status_code=403, detail=COMMUNITY_ERROR_POST)
        try:
            member = store.is_community_member(community_id, user_id)
        except StoreError:
            raise HTTPException(status_code=503, detail="読み込みに失敗しました。もう一度お試しください。")
        if not member:
            raise HTTPException(status_code=403, detail=COMMUNITY_ERROR_POST)
        extras = {**extras, "community_id": community_id}

    x, y, cluster_id, terms, vector, centred = project(body)
    record = {
        "author_id": user_id,
        "body": body,
        "tags": tags,
        "motivation": clean_motivation(payload.motivation),
        "image_path": payload.image_path or None,
        **extras,
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
    try:
        notify_resident(row["id"], user_id, account.get("display_name", ""),
                        community=community_id if members else None, post_community=community_id)
    except Exception:  # a failed notice never costs the post
        _logger.exception("resident notice failed")
    try:
        start_match_notice(row["id"])
    except Exception:  # a failed notice never costs the post
        _logger.warning("match notice could not start for %s", row["id"])

    result_island = island_of(row["id"], community_id) if members else island_of(row["id"])
    if any((state.get("naming_pending") or {}).values()):
        maybe_track_islands()  # a new island waiting for its AI name is named within a minute
    return {
        **row,
        "display_name": account.get("display_name", ""),
        "icon_id": account.get("icon_id", "0"),
        "avatar_path": account.get("avatar_path"),
        "island": result_island,
        "neighbors": (neighbors_for(row["id"], terms, NEIGHBOR_COUNT, community=community_id)
                      if members else neighbors_for(row["id"], terms, NEIGHBOR_COUNT)),
    }


def preview_island(x, y, community=None):
    """The named landmass a point would stand on: that of the nearest saved
    post, if it is close enough to share its ground. Otherwise open water.
    With `community` (members_only) only that community's posts count."""
    radius = PREVIEW_ISLAND_RADIUS
    try:
        if community:
            # The member-filtered map_posts has no viewer under the server's key: its own function.
            nearby = state["store"].map_posts_for_community(
                community, x - radius, y - radius, x + radius, y + radius, 200)
        else:
            nearby = state["store"].map_posts(x - radius, y - radius, x + radius, y + radius, 200)
    except StoreError:
        return None
    best, best_d = None, radius
    for row in nearby:
        d = math.hypot(float(row["x"]) - x, float(row["y"]) - y)
        if d <= best_d:
            best, best_d = row, d
    if not best:
        return None
    return island_of(best["id"], community) if community else island_of(best["id"])


@app.post("/api/posts/preview")
def preview_post(payload: PostPreview, request: Request):
    """Where a text WOULD stand, without saving it (Q40's tryout).

    The first post is made by choosing an example sentence. Saving those would
    fill the map with the same few sentences, so this places one, says which
    island and who is near, and keeps nothing.
    """
    user_id = current_user(request)
    community_id = None
    if members_only_on():
        # members_only: a text is tried out among the posts of ONE community the caller is in.
        community_id = (require_member(user_id, payload.community_id) if payload.community_id
                        else only_community_of(user_id))
    body = clean_body(payload.body)
    if not check_rate_limit(f"preview:{user_id}"):
        raise HTTPException(status_code=429, detail="少し時間をおいてからお試しください。")
    x, y, cluster_id, terms, _vector, centred = project(body)
    try:
        ranked = state["store"].nearest_to_vector([float(v) for v in centred], PREVIEW_NEIGHBORS,
                                                  **scoped(community_id))
    except StoreError:
        ranked = []
    return {
        "body": body,
        "x": x,
        "y": y,
        "cluster_id": cluster_id,
        "terms": terms,
        "island": preview_island(x, y, community_id),
        "neighbors": neighbor_rows(ranked, terms, community=community_id),
        "saved": False,
    }


_ANON_VIEWER = re.compile(r"^anon:[0-9a-f]{16,64}$")


@app.post("/api/posts/{post_id}/view")
def record_view(post_id: str, payload: PostView, request: Request):
    """One footprint (Q35). Each viewer counts once per post; the author never.

    Signed in, the viewer is the account. Signed out, it is a random key the
    browser keeps, which is good enough for "about how many people saw this"
    and is all Q35 asks for: the number, never who.
    """
    try:
        uuid.UUID(post_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="見つかりませんでした。")
    if members_only_on():
        # members_only: only a signed-in member of the post's community leaves a footprint (the
        # random key of a signed-out browser no longer counts), and anybody else is told the post
        # is not there.
        viewer = current_user(request)
        member_post(viewer, post_id)
    else:
        viewer = optional_user(request)
    if not viewer:
        viewer = (payload.viewer or "").strip().lower()
        if not _ANON_VIEWER.match(viewer):
            raise HTTPException(status_code=422, detail="閲覧者のキーが不正です。")
    try:
        counted = state["store"].record_view(post_id, viewer)
    except StoreError:
        # A lost footprint is not worth an error on somebody else's screen.
        counted = False
    return {"counted": counted}


@app.get("/api/me/views")
def my_views(request: Request):
    """How many people opened each of my posts. Only ever my own (Q35, Q46)."""
    user_id = current_user(request)
    try:
        views = state["store"].view_counts(user_id)
    except StoreError:
        raise HTTPException(status_code=503, detail="読み込みに失敗しました。")
    return {"views": views}


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
    members = members_only_on()

    def not_yours(old_detail):
        # members_only: somebody else's post and a post that is not there answer alike (404).
        if members:
            return HTTPException(status_code=404, detail=MEMBERS_ONLY_NOT_FOUND)
        return HTTPException(status_code=403, detail=old_detail)

    fields = {}
    terms = None
    sent = payload.model_fields_set
    extras_sent = sent & {"prompt", "recruit_deadline", "recruit_capacity"}
    extras_on = post_extras_on()
    recruit_sent = bool(extras_on and sent & {"recruit_deadline", "recruit_capacity"})
    existing = None
    if payload.body is not None or recruit_sent:
        try:
            existing = store.get_post(post_id)
        except StoreError:
            raise HTTPException(status_code=503, detail="読み込みに失敗しました。")
        if not existing:
            raise HTTPException(status_code=404, detail="見つかりませんでした。")
        if existing["author_id"] != user_id:
            raise not_yours("自分の投稿だけ編集できます。")
    if payload.body is not None:
        body = clean_body(payload.body)
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
        if extras_on and RECRUIT_TAG not in fields["tags"]:
            fields.update({"recruit_deadline": None, "recruit_capacity": None})
    if extras_on:
        try:
            if "prompt" in sent:
                fields["prompt"] = post_extras.clean_prompt(payload.prompt)
            if recruit_sent:
                tags_now = fields.get("tags", existing.get("tags") or [])
                if RECRUIT_TAG not in tags_now:
                    fields.update({"recruit_deadline": None, "recruit_capacity": None})
                else:
                    if "recruit_deadline" in sent:
                        fields["recruit_deadline"] = post_extras.clean_deadline(
                            payload.recruit_deadline, keep=existing.get("recruit_deadline"))
                    if "recruit_capacity" in sent:
                        fields["recruit_capacity"] = post_extras.clean_capacity(payload.recruit_capacity)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error))
    if payload.motivation is not None:
        fields["motivation"] = clean_motivation(payload.motivation)
    if payload.clear_image:
        fields["image_path"] = None
    elif payload.image_path is not None:
        fields["image_path"] = payload.image_path

    if not fields and extras_sent and not extras_on:
        # The database cannot keep these yet: ignore them and still succeed.
        try:
            row = store.get_post(post_id)
        except StoreError:
            raise HTTPException(status_code=503, detail="読み込みに失敗しました。")
        if not row or row["author_id"] != user_id:
            raise not_yours("編集できませんでした。")
        return {**row, "island": island_for_viewer(row, user_id)}
    if not fields:
        raise HTTPException(status_code=422, detail="変更点がありません。")

    # The same post on other communities' maps (2026-10-29) is the same words: every copy changes, in
    # one statement (all of them or none, never one map with new words and another with the old).
    group = None
    if share_on():
        if existing is None:
            try:
                existing = store.get_post(post_id)
            except StoreError:
                raise HTTPException(status_code=503, detail="読み込みに失敗しました。")
        if existing and existing["author_id"] == user_id:
            group = existing.get("share_group")
    try:
        if group:
            rows = store.update_post_group(group, user_id, fields)
            row = next((entry for entry in rows if str(entry["id"]) == str(existing["id"])), None)
        else:
            row = store.update_post(post_id, user_id, fields)
    except StoreError:
        raise HTTPException(status_code=503,
                            detail=SHARE_ERROR_SYNC if group else "保存に失敗しました。もう一度お試しください。")
    if not row:
        raise not_yours("編集できませんでした。")
    if terms is not None:
        invalidate_islands()
    return {**row, "island": island_for_viewer(row, user_id)}


@app.post("/api/posts/{post_id}/share")
def share_post(post_id: str, payload: PostShare, request: Request):
    """Put one of my posts on the maps of other communities I am in too (2026-10-29, B案).

    Each community gets a row of its own (its own likes, messages and joins: the walls between
    communities stay), and the rows are joined by posts.share_group. A copy stands where the post
    stands (the same words and vectors, so nothing is projected again), and it is new in that
    community: written now, and the residents of its island hear of a newcomer the usual way. A
    community that has the post already is skipped, so pressing twice changes nothing."""
    user_id = current_user(request)
    if not members_only_on() or not share_on():
        raise HTTPException(status_code=409, detail=SHARE_ERROR_OFF)
    store = state["store"]
    pid = _norm_uuid(post_id)
    if not pid:
        raise HTTPException(status_code=404, detail=MEMBERS_ONLY_NOT_FOUND)
    try:
        original = store.get_post(pid, with_vec=True)
    except StoreError:
        raise HTTPException(status_code=503, detail="読み込みに失敗しました。")
    if not original or original["author_id"] != user_id:
        raise HTTPException(status_code=404, detail=MEMBERS_ONLY_NOT_FOUND)
    if len(original.get("body") or "") > MAX_TEXT_LENGTH:
        # Written before the 60-character limit: the database takes no new post that long.
        raise HTTPException(status_code=422, detail=SHARE_ERROR_LONG)
    mine = viewer_communities(user_id)
    wanted = []
    for raw in payload.community_ids:
        cid = _norm_uuid(raw)
        if not cid or cid not in mine:
            raise HTTPException(status_code=403, detail=COMMUNITY_ERROR_POST)
        if cid not in wanted:
            wanted.append(cid)
    if not wanted:
        raise HTTPException(status_code=422, detail=SHARE_ERROR_NONE)
    if not check_rate_limit(user_id):
        raise HTTPException(status_code=429, detail="少し時間をおいてからお試しください。")

    group = original.get("share_group") or original["id"]
    added = []
    account = {}
    failed = False
    rows = []
    try:
        account = store.get_account(user_id) or {}
        if not original.get("share_group"):
            store.update_post(pid, user_id, {"share_group": group})
        present = {str(row.get("community_id")) for row in store.posts_in_group(group)}
        for cid in wanted:
            if cid in present:
                continue
            record = {
                "id": str(uuid.uuid4()),
                "author_id": user_id,
                "community_id": cid,
                "share_group": group,
                **{name: original.get(name) for name in (
                    "body", "tags", "motivation", "image_path", "x", "y", "cluster_id", "terms",
                    "vec", "vec_c")},
            }
            if post_extras_on():
                record.update({name: original.get(name) for name in (
                    "prompt", "recruit_deadline", "recruit_capacity")})
            try:
                added.append(store.insert_post(record))
            except StoreError:
                # Pressed twice at once: the other press made the copy (one live copy per community).
                if cid not in {str(row.get("community_id")) for row in store.posts_in_group(group)}:
                    raise
        rows = store.posts_in_group(group)
    except StoreError:
        failed = True
    # A copy that was made stays made even when a later one failed: its island and its residents
    # hear of it now (pressing again skips it, so this is the only time they would).
    if added:
        invalidate_islands()
    for row in added:
        try:
            notify_resident(row["id"], user_id, account.get("display_name", ""),
                            community=row["community_id"], post_community=row["community_id"])
        except Exception:  # a failed notice never costs the copy
            _logger.exception("resident notice failed")
    if failed:
        raise HTTPException(status_code=503, detail=SHARE_ERROR_FAILED)
    return {
        "share_group": group,
        "added": [str(row["community_id"]) for row in added],
        # Only the copies in communities the author is still in (a left community's copy stays theirs,
        # but its map is not theirs to open).
        "posts": [row for row in rows if str(row.get("community_id")) in mine],
    }


@app.delete("/api/posts/{post_id}")
def delete_post(post_id: str, request: Request, scope: str = "one"):
    """Soft delete. The comments other people left are their words, not ours.

    A post that is on several communities' maps (2026-10-29): `scope=all` deletes every copy,
    anything else only this community's (「このコミュニティだけ外す」)."""
    user_id = current_user(request)
    store = state["store"]
    try:
        if scope == "all":
            post = store.get_post(post_id) if _norm_uuid(post_id) else None
            if post and post["author_id"] == user_id and post.get("share_group"):
                removed = store.soft_delete_post_group(post["share_group"], user_id) > 0
            else:
                removed = store.soft_delete_post(post_id, user_id)
        else:
            removed = store.soft_delete_post(post_id, user_id)
    except StoreError:
        raise HTTPException(status_code=503, detail="削除に失敗しました。もう一度お試しください。")
    if not removed:
        raise HTTPException(status_code=403, detail="削除できませんでした。")
    invalidate_islands()
    return {"ok": True}


@app.delete("/api/comments/{comment_id}")
def delete_comment(comment_id: str, request: Request):
    """Soft delete one of your own messages.

    Through here and not straight from the browser: a PATCH that sets
    deleted_at makes the row one the comments_read policy hides, and PostgREST
    asks for the row back, so the database refuses the whole update ("new row
    violates row-level security policy"). The store writes with the service
    key, checks the author itself and gives the post its comment back (2026-10-21).
    """
    user_id = current_user(request)
    try:
        uuid.UUID(comment_id)
    except ValueError:
        # Not an id at all: the database would answer 400, read as an outage.
        raise HTTPException(status_code=403, detail="削除できませんでした。")
    try:
        removed = state["store"].delete_comment(comment_id, user_id)
    except StoreError:
        raise HTTPException(status_code=503, detail="削除に失敗しました。もう一度お試しください。")
    if not removed:
        raise HTTPException(status_code=403, detail="削除できませんでした。")
    # One message fewer: the post's energy (and so its island) changes too.
    invalidate_connections()
    invalidate_islands()
    return {"ok": True}


@app.get("/api/neighbors")
def neighbors(request: Request, post: str = "", limit: int = ORBIT_NEIGHBOR_COUNT):
    """Who is near this post, measured before the squash.

    This is what the orbit view places people by, and what the profile sheet
    prints. Never the map distance: ranking by map distance put a different
    topic at the top for 3 of 12 measured people; ranking by cosine got 12 of 12.
    """
    members = members_only_on()
    if members:
        # members_only: a post's neighbours are for the members of its community. An author who
        # has left cannot seed this with an old post: membership, not authorship.
        user_id = current_user(request)
        if not post:
            raise HTTPException(status_code=422, detail="投稿が指定されていません。")
        origin = member_post(user_id, post)
        community = str(origin["community_id"])
        limit = max(1, min(int(limit), 100))
        return {
            "post": post,
            "island": island_of(post, community),
            "neighbors": neighbors_for(post, origin.get("terms") or [], limit, community=community),
        }
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
        # A post of a community is near the people of that community only (its map).
        "neighbors": neighbors_for(post, origin.get("terms") or [], limit,
                                   community=origin.get("community_id") if communities_on() else None),
    }


@app.get("/api/matches")
def matches(request: Request, post: str = ""):
    """Up to three people whose post connects to the caller's own post (the cards after posting).

    Only the author asks (404 otherwise). Anything that goes wrong answers an empty list, so the
    screen falls back to what it showed before.
    """
    user_id = current_user(request)
    if not post:
        raise HTTPException(status_code=422, detail="投稿が指定されていません。")
    if members_only_on():
        origin = member_post(user_id, post)
    else:
        try:
            origin = state["store"].get_post(post)
        except StoreError:
            raise HTTPException(status_code=503, detail="読み込みに失敗しました。")
    if not origin or origin.get("author_id") != user_id:
        raise HTTPException(status_code=404, detail=MEMBERS_ONLY_NOT_FOUND)
    # Switched off or failed: empty too, but marked, so the screen does not tell "nobody yet".
    unknown = {"post": post, "matches": [], "unknown": True}
    if os.environ.get("ISLANDS_MATCH_CARDS", "1") == "0":
        return unknown
    try:
        return {"post": post, "matches": match_rows(user_id, origin)}
    except Exception as error:
        _logger.warning("matches failed for %s: %s", post, error)
        return unknown


def pick_connections(user_id, origin, members=None):
    """The posts that connect to `origin` (written by `user_id`): nearest posts -> bar -> stance -> pick.

    One answer for the cards (GET /api/matches) and for the 'match' notices. `members`: when given,
    only posts of these authors count (the notice skips people who left the community).
    Returns the picked candidates ({"id", "author_id", "prompt", "tags", "cosine", "reason", "kind"})
    and the community id the search was held to."""
    store = state["store"]
    community = origin.get("community_id")
    community = str(community) if community and (members_only_quiet() or communities_on()) else None
    if community and members_only_quiet():
        ranked = store.nearest_posts(origin["id"], MATCH_CANDIDATES, community=community)
    elif community:
        of_community = store.post_communities()
        ranked = [pair for pair in store.nearest_posts(origin["id"], min(max(MATCH_CANDIDATES * 6, 60), 300))
                  if of_community.get(pair[0]) == community][:MATCH_CANDIDATES]
    else:
        ranked = store.nearest_posts(origin["id"], MATCH_CANDIDATES)
    # Below the lowest bar nothing can be shown: skip the lookups.
    bar = matching.lowest_bar()
    ranked = [(other_id, cosine) for other_id, cosine in ranked if cosine >= bar]
    if not ranked:
        return [], community
    candidates = []
    for other_id, cosine in ranked:
        try:
            other = store.get_post(other_id)
        except StoreError:
            continue
        if not other or other.get("deleted_at") or other["author_id"] == user_id:
            continue
        if community and members_only_quiet() and other.get("community_id") != community:
            continue
        if members is not None and other["author_id"] not in members:
            continue
        candidates.append({"id": other["id"], "author_id": other["author_id"], "prompt": other.get("prompt"),
                           "tags": other.get("tags") or [], "cosine": float(cosine)})
    blocked = store.blocked_with(user_id) if candidates else set()
    picked = matching.pick_matches(
        {"author_id": user_id, "prompt": origin.get("prompt"), "tags": origin.get("tags") or []},
        candidates, limit=MATCH_LIMIT, excluded_authors=blocked)
    return picked, community


def match_rows(user_id, origin):
    """The cards for `origin`: the connections (pick_connections) with the people's names."""
    picked, community = pick_connections(user_id, origin)
    if not picked:
        return []
    extra = {item["id"]: item for item in picked}
    rows = neighbor_rows([(item["id"], item["cosine"]) for item in picked], origin.get("terms") or [],
                         community=community if members_only_quiet() else None)
    return [{**row, "prompt": extra[row["id"]]["prompt"], "reason": extra[row["id"]]["reason"],
             "kind": extra[row["id"]]["kind"]} for row in rows]


def notify_matches(post_id, now=None):
    """Tell the people whose older post connects to the new post `post_id` (a 'match' notification).

    A new post P (author A) that pick_connections joins to an older post Q (author B), at most
    MATCH_LIMIT of them, tells B once: payload {kind, other_post: Q, reason}, `reason` being what B
    reads (matching.NOTICE_REASONS, seen from B). No per-day limit; the same P and B never twice.
    Nobody is told who is A, who blocked or was blocked by A, who left the community, or when Q is
    gone. Never raises: any failure (also a database that has not had 20261029020000_match_notice.sql
    yet) is a warning in the log and the post is untouched. Returns the rows written."""
    if os.environ.get("ISLANDS_MATCH_NOTICE", "1") == "0":
        return []
    try:
        store = state["store"]
        now = now or datetime.now(timezone.utc)
        origin = store.get_post(post_id)
        if not origin or origin.get("deleted_at"):
            return []
        author = origin["author_id"]
        raw_community = origin.get("community_id")
        community = str(raw_community) if raw_community and (members_only_quiet() or communities_on()) else None
        members = set(store.community_member_ids(community)) if community else None
        picked, _community = pick_connections(author, origin, members=members)
        if not picked:
            return []
        told = {(str(row.get("post_id")), row["recipient_id"]) for row in store.recent_notifications(
            "match", now - timedelta(days=1), recipient_ids=[item["author_id"] for item in picked])}
        rows = [{
            "recipient_id": item["author_id"], "actor_id": author, "type": "match", "post_id": post_id,
            "payload": {"kind": item["kind"], "other_post": item["id"],
                        "reason": matching.NOTICE_REASONS.get(item["kind"], matching.NOTICE_REASONS["near"])},
            **({"community_id": raw_community} if raw_community else {}),
        } for item in picked if (str(post_id), item["author_id"]) not in told]
        if rows:
            store.insert_notifications(rows)
        return rows
    except Exception as error:
        _logger.warning("match notice failed for %s: %s", post_id, error)
        return []


def start_match_notice(post_id):
    """notify_matches in a background thread, so the answer to the writer does not wait for it.
    ISLANDS_AUTO_MATCH_NOTICE=0 keeps it from starting (tests call notify_matches themselves)."""
    if (os.environ.get("ISLANDS_AUTO_MATCH_NOTICE", "1") == "0"
            or os.environ.get("ISLANDS_MATCH_NOTICE", "1") == "0"):
        return None
    thread = threading.Thread(target=notify_matches, args=(post_id,), name="match-notice", daemon=True)
    thread.start()
    return thread


@app.get("/api/pair")
def pair(request: Request, a: str = "", b: str = ""):
    """似てる度 and shared words for two posts. What the sheet shows."""
    members = members_only_on()
    user_id = current_user(request) if members else None
    if not a or not b or a == b:
        raise HTTPException(status_code=422, detail="2つの投稿を指定してください。")
    store = state["store"]
    if members:
        # members_only: both posts are ones the caller reads as a member, and of ONE community.
        first, second = member_post(user_id, a), member_post(user_id, b)
        if first.get("community_id") != second.get("community_id"):
            raise HTTPException(status_code=404, detail=MEMBERS_ONLY_NOT_FOUND)
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

def local_mode_allowed():
    """Local mode is a developer's stand-in. On Cloud Run (K_SERVICE is set) it is refused unless
    ISLANDS_LOCAL=1 says it is meant."""
    return not os.environ.get("K_SERVICE") or os.environ.get("ISLANDS_LOCAL") == "1"


def require_local():
    if not state.get("local_mode") or not local_mode_allowed():
        raise HTTPException(status_code=404, detail="not found")


def local_viewer(request):
    """Who a /api/local read is for. With members_only on, PostgREST would answer a signed-out
    caller with nothing; here that is a 401, and a signed-in one is the viewer the store's
    row-level rules are applied for. With it off, the viewer is ignored (reads were open)."""
    if _members_flag():
        return current_user(request)
    return optional_user(request)


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
def local_map(request: Request, min_x: float = MAP_MIN, min_y: float = MAP_MIN,
              max_x: float = MAP_MAX, max_y: float = MAP_MAX,
              limit: int = MAP_POST_LIMIT):
    require_local()
    viewer = local_viewer(request)
    limit = max(1, min(int(limit), 2000))
    return {"posts": state["store"].map_posts(min_x, min_y, max_x, max_y, limit, viewer=viewer)}


@app.get("/api/local/cells")
def local_cells(request: Request, min_x: float = MAP_MIN, min_y: float = MAP_MIN,
                max_x: float = MAP_MAX, max_y: float = MAP_MAX):
    require_local()
    viewer = local_viewer(request)
    return {"cells": state["store"].map_cells(min_x, min_y, max_x, max_y, viewer=viewer)}


@app.get("/api/local/post/{post_id}")
def local_get_post(post_id: str, request: Request):
    require_local()
    store = state["store"]
    post = store.get_post(post_id, viewer=local_viewer(request))
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
def local_posts_by_author(request: Request, author: str = ""):
    require_local()
    viewer = local_viewer(request)
    if not author:
        raise HTTPException(status_code=422, detail="author を指定してください。")
    return {"posts": state["store"].posts_by_author(author, viewer=viewer)}


@app.get("/api/local/comments")
def local_comments(request: Request, post: str = ""):
    require_local()
    return {"comments": state["store"].list_comments(post, viewer=local_viewer(request))}


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
    try:
        created = state["store"].add_reaction(payload.post_id, user_id, payload.kind)
    except StoreError as error:
        # Same words the database trigger raises for the direct insert (2026-10-20).
        if str(error) in (post_extras.ERROR_CLOSED, post_extras.ERROR_FULL):
            raise HTTPException(status_code=409, detail=str(error))
        raise
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


@app.get("/api/local/posts/{post_id}/joiners")
def local_joiners(post_id: str, request: Request):
    """Who joined a post: the local stand-in for reading the reactions table."""
    require_local()
    return {"joiners": state["store"].joiners_of(post_id, viewer=local_viewer(request))}


@app.get("/api/local/posts/{post_id}/reactors")
def local_reactors(post_id: str, request: Request, kind: str = "like"):
    """Who pressed いいね / 手伝えるかも / 参加 on a post, with their names and icons."""
    require_local()
    viewer = local_viewer(request)
    try:
        reactors = state["store"].reactors_of(post_id, kind, viewer=viewer)
    except StoreError:
        raise HTTPException(status_code=422, detail="kind は like / help / join のどれかです。")
    return {"reactors": reactors}


@app.get("/api/local/notifications")
def local_notifications(request: Request):
    require_local()
    user_id = current_user(request)
    return {"notifications": state["store"].list_notifications(user_id, viewer=user_id)}


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
    feed = notices.group_feed(store.list_notifications(user_id, limit=500, viewer=user_id),
                              max(1, min(int(limit), 100)))
    for entry in feed:
        entry["interrupts"] = notices.allows(settings, entry["type"], "in_app")
    unread = sum(1 for entry in feed if entry["unread"] and entry["interrupts"])
    return {"notifications": feed, "unread": unread, "settings": settings}


@app.post("/api/local/presence")
def local_presence(payload: Presence, request: Request):
    """mark_active() for local mode: the app is on screen for `seconds`, 0 clears it."""
    require_local()
    user_id = current_user(request)
    state["store"].mark_active(user_id, max(0, min(int(payload.seconds), 120)))
    return {"ok": True}


@app.post("/api/local/notifications/read")
def local_mark_read(payload: ReadRequest, request: Request):
    require_local()
    user_id = current_user(request)
    return {"updated": state["store"].mark_notifications_read(user_id, payload.ids)}


@app.post("/api/local/reports")
def local_report(payload: ReportCreate, request: Request):
    require_local()
    user_id = current_user(request)
    try:
        state["store"].add_report(user_id, payload.post_id, payload.comment_id, payload.reason)
    except StoreError:
        # members_only: a post / comment the reporter is not a member of fails like a missing one.
        raise HTTPException(status_code=404, detail="見つかりませんでした。")
    return {"ok": True}


# -- 「話してみたい」and DM (2026-10-26) ------------------------------------------
# Stand-ins for the database functions the browser calls itself in a deployment
# (talk_peers, my_talk_state, press_talk, withdraw_talk, dm_room_list) and for the
# dm_messages / dm_blocks tables. The words of a refusal are the database's.

class TalkTarget(BaseModel):
    target: str


class DmBody(BaseModel):
    body: str


class DmBlock(BaseModel):
    blocked_id: str


def _talk_refusal(error):
    return HTTPException(status_code=error.status, detail=str(error))


_refusal = _talk_refusal  # the same shape for communities and invites (a Refused has a status)


@app.get("/api/local/talk/peers")
def local_talk_peers(request: Request):
    require_local()
    return {"peers": state["store"].talk_peers(current_user(request))}


@app.get("/api/local/talk/state")
def local_talk_state(request: Request):
    require_local()
    return {"state": state["store"].talk_state(current_user(request))}


@app.post("/api/local/talk/press")
def local_talk_press(payload: TalkTarget, request: Request):
    require_local()
    user_id = current_user(request)
    try:
        return state["store"].press_talk(user_id, payload.target)
    except TalkRefused as error:
        raise _talk_refusal(error)


@app.post("/api/local/talk/withdraw")
def local_talk_withdraw(payload: TalkTarget, request: Request):
    require_local()
    try:
        state["store"].withdraw_talk(current_user(request), payload.target)
    except TalkRefused as error:
        raise _talk_refusal(error)
    return {"ok": True}


@app.get("/api/local/dm/rooms")
def local_dm_rooms(request: Request):
    require_local()
    return {"rooms": state["store"].dm_room_list(current_user(request))}


@app.get("/api/local/dm/rooms/{room_id}/messages")
def local_dm_messages(room_id: str, request: Request, after: str | None = None):
    require_local()
    user_id = current_user(request)
    try:
        return {"messages": state["store"].dm_messages(user_id, room_id, after)}
    except TalkRefused as error:
        raise _talk_refusal(error)
    except ValueError:
        raise HTTPException(status_code=422, detail="after は時刻で指定してください。")


@app.post("/api/local/dm/rooms/{room_id}/messages")
def local_dm_send(room_id: str, payload: DmBody, request: Request):
    require_local()
    user_id = current_user(request)
    try:
        return {"message": state["store"].send_dm(user_id, room_id, payload.body)}
    except TalkRefused as error:
        raise _talk_refusal(error)
    except StoreError:
        raise HTTPException(status_code=422, detail=f"メッセージは1〜{DM_BODY_MAX}字で入力してください。")


@app.post("/api/local/dm/blocks")
def local_dm_block(payload: DmBlock, request: Request):
    require_local()
    try:
        state["store"].block_dm(current_user(request), payload.blocked_id)
    except StoreError:
        raise HTTPException(status_code=422, detail="ブロックできませんでした。")
    return {"ok": True}


@app.delete("/api/local/dm/blocks/{blocked_id}")
def local_dm_unblock(blocked_id: str, request: Request):
    require_local()
    state["store"].unblock_dm(current_user(request), blocked_id)
    return {"ok": True}


# -- communities and invite links (2026-10-26) ------------------------------------
# Stand-ins for the database functions the browser calls itself in a deployment
# (check_invite, claim_invite, create_invite, list_invites, revoke_invite, my_communities,
# community_map_posts). The words of a refusal are the database's. 4xx {detail} here,
# PostgREST {message} there. The last three routes (create a community, the invite_only
# switch, expiring an invite) have no SQL-function twin: in production an operator does
# those in the SQL editor. They exist for tests and for trying the screens by hand.

class InviteCode(BaseModel):
    code: str


class InviteCreate(BaseModel):
    community_id: str
    minutes: int = 60
    until_end_of_day: bool = False


class CommunityCreate(BaseModel):
    name: str
    slug: str | None = None


class InviteOnlySwitch(BaseModel):
    value: bool


INVITE_CHECK_LIMIT = 100  # checks per rate-limit window and client address


@app.get("/api/local/communities/mine")
def local_my_communities(request: Request):
    require_local()
    return {"communities": state["store"].my_communities(current_user(request))}


@app.get("/api/local/invites/check/{code}")
def local_check_invite(code: str, request: Request):
    """{"valid", "community_name", "reason"} and nothing else. Anybody may ask."""
    require_local()
    client = request.client.host if request.client else "?"
    if not check_rate_limit(f"invite-check:{client}", INVITE_CHECK_LIMIT):
        raise HTTPException(status_code=429, detail="少し時間をおいてからお試しください。")
    return state["store"].check_invite(code)


@app.post("/api/local/invites/claim")
def local_claim_invite(payload: InviteCode, request: Request):
    require_local()
    user_id = current_user(request)
    try:
        return state["store"].claim_invite(user_id, payload.code)
    except Refused as error:
        raise _refusal(error)


@app.post("/api/local/invites")
def local_create_invite(payload: InviteCreate, request: Request):
    require_local()
    user_id = current_user(request)
    try:
        return state["store"].create_invite(user_id, payload.community_id, payload.minutes,
                                            payload.until_end_of_day)
    except Refused as error:
        raise _refusal(error)


@app.get("/api/local/invites")
def local_list_invites(request: Request, community_id: str = ""):
    require_local()
    user_id = current_user(request)
    try:
        return {"invites": state["store"].list_invites(user_id, community_id)}
    except Refused as error:
        raise _refusal(error)


@app.post("/api/local/invites/{invite_id}/revoke")
def local_revoke_invite(invite_id: str, request: Request):
    require_local()
    user_id = current_user(request)
    try:
        state["store"].revoke_invite(user_id, invite_id)
    except Refused as error:
        raise _refusal(error)
    return {"ok": True}


class CommunityRename(BaseModel):
    name: str


@app.post("/api/local/communities/{community_id}/rename")
def local_rename_community(community_id: str, payload: CommunityRename, request: Request):
    """rename_community: an admin of that community changes its name. {"name"} is the new one."""
    require_local()
    user_id = current_user(request)
    try:
        return {"name": state["store"].rename_community(user_id, community_id, payload.name)}
    except Refused as error:
        raise _refusal(error)


@app.get("/api/local/communities/{community_id}")
def local_community_info(community_id: str, request: Request):
    """{id, name} of one community (production: a read of the communities table; with members_only
    on, communities_read shows a community to its members only)."""
    require_local()
    info = state["store"].community_info(community_id, viewer=local_viewer(request))
    if not info:
        raise HTTPException(status_code=404, detail="not found")
    return info


@app.get("/api/local/communities/{community_id}/map")
def local_community_map(community_id: str, request: Request, min_x: float = MAP_MIN,
                        min_y: float = MAP_MIN, max_x: float = MAP_MAX, max_y: float = MAP_MAX,
                        limit: int = MAP_POST_LIMIT):
    """community_map_posts: the same rows as /api/local/map, for one community only
    (members_only: members of that community only)."""
    require_local()
    viewer = local_viewer(request)
    limit = max(1, min(int(limit), 2000))
    return {"posts": state["store"].community_map_posts(
        community_id, min_x, min_y, max_x, max_y, limit, viewer=viewer)}


@app.post("/api/local/communities/{community_id}/leave")
def local_leave_community(community_id: str, request: Request):
    """Deleting your own community_members row (production: the browser does it, under the
    can_leave_community rule). {"left": false} for a last admin or somebody who was not in."""
    require_local()
    return {"left": state["store"].leave_community(current_user(request), community_id)}


@app.post("/api/local/communities")
def local_create_community(payload: CommunityCreate, request: Request):
    """Dev helper: make a community with the signed-in person as its admin (an operator's
    `select create_community(...)` in production)."""
    require_local()
    user_id = current_user(request)
    try:
        community_id = state["store"].create_community(payload.name, payload.slug, user_id)
    except StoreError:
        raise HTTPException(status_code=422, detail="コミュニティ名は1〜40字で、スラッグは重ならないようにしてください。")
    return {"community_id": community_id, "name": payload.name.strip(), "slug": payload.slug}


@app.get("/api/local/settings/invite-only")
def local_get_invite_only():
    require_local()
    return {"invite_only": state["store"].invite_only()}


@app.post("/api/local/settings/invite-only")
def local_set_invite_only(payload: InviteOnlySwitch):
    """Dev helper: flip app_settings.invite_only (production: one UPDATE in the SQL editor)."""
    require_local()
    state["store"].set_invite_only(payload.value)
    return {"invite_only": state["store"].invite_only()}


class MembersOnlySwitch(BaseModel):
    value: bool


@app.get("/api/local/settings/members-only")
def local_get_members_only():
    require_local()
    return {"members_only": state["store"].members_only()}


@app.post("/api/local/settings/members-only")
def local_set_members_only(payload: MembersOnlySwitch):
    """Dev helper: flip app_settings.members_only (production: the lockdown / rollback SQL does it)."""
    require_local()
    state["store"].set_members_only(payload.value)
    invalidate_islands()
    invalidate_connections()
    return {"members_only": state["store"].members_only()}


@app.post("/api/local/invites/{invite_id}/expire")
def local_expire_invite(invite_id: str):
    """Dev helper: make an invite already past its expiry (for an 'expired link' test)."""
    require_local()
    if not state["store"].expire_invite(invite_id):
        raise HTTPException(status_code=404, detail="見つかりませんでした。")
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


@app.get("/api/local/storage/list")
def local_storage_list(request: Request, folder: str = ""):
    """The storage listing of the post-images bucket. Phase 1 of members-only images: a person lists
    their OWN folder only (the policy compares the first path segment with their id); everybody else's
    folder, and the bucket root, answer nothing. Opening a file by its exact URL still works for
    anyone who has it (the bucket stays public until the private-bucket change)."""
    require_local()
    viewer = local_viewer(request)
    if _members_flag() and (not viewer or folder.strip("/") != viewer):
        return {"objects": []}
    prefix = folder.strip("/") + "/"
    return {"objects": sorted(path[len(prefix):] for path in state["images"] if path.startswith(prefix))}


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
    if "affiliation" in fields and not str(fields["affiliation"] or "").strip():
        # 2026-10-29: required, like the name. Only a save that carries the key
        # is checked, so a photo-only save from an older account still goes through.
        raise HTTPException(status_code=422, detail="所属組織を入力してください。")
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
    except InviteRequired as error:
        # invite_only is on and this is a NEW account with no invite (the database trigger's words).
        raise HTTPException(status_code=error.status, detail=str(error))
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


@app.get("/privacy")
def privacy():
    return FileResponse(WEB / "privacy.html", headers=NO_CACHE)


@app.get("/terms")
def terms():
    return FileResponse(WEB / "terms.html", headers=NO_CACHE)


@app.get("/sw.js")
def service_worker():
    # Served from the root so its scope is the whole app.
    return FileResponse(WEB / "sw.js", media_type="text/javascript", headers=NO_CACHE)


@app.get("/manifest.webmanifest")
def web_manifest():
    return FileResponse(WEB / "manifest.webmanifest", media_type="application/manifest+json",
                        headers=NO_CACHE)


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
