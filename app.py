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
import os
import pickle
import re
import secrets
import threading
import time
import uuid
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from core import auth
from core.clustering import assign_cluster, name_group
from core.config import (
    ISLAND_COLORS,
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
    ORBIT_NEIGHBOR_COUNT,
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
ARTIFACTS = ROOT / "artifacts"
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


# --------------------------------------------------------------------------
# startup
# --------------------------------------------------------------------------

def load_artifacts():
    """Load the frozen map. Missing artifacts is a hard failure, not a warning."""
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
    _gemini = bool(os.environ.get("GEMINI_API_KEY", "").strip())
    _label = f"Gemini API ({GEMINI_MODEL_NAME})" if _gemini else "ONNX (multilingual-e5-small)"
    print(f"埋め込みモデルを読み込み中: {_label}", flush=True)
    state["model"] = load_embedder()
    state["store"] = create_store()
    state["local_mode"] = state["store"].backend == "memory"
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


app = FastAPI(title="かさなり", lifespan=lifespan, docs_url=None, redoc_url=None)

# The free egress allowance on the deploy target is 1GiB/month, and the web
# assets are highly compressible text. minimum_size skips the small JSON
# replies, where the header would cost more than the compression saves.
app.add_middleware(GZipMiddleware, minimum_size=1024)


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
            detail=f"本文は{MIN_TEXT_LENGTH}字以上でお願いします（現在{len(text)}字）。",
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
    features, _token_lists, zero_rows, _ = build_hybrid_features(
        [text], state["model"], fit_sparse=False, sparse_artifacts=state["sparse_artifacts"]
    )
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

    named = name_landmasses(posts, state["idf"], name_group)
    # post_ids can run to thousands and the client never uses them; they exist
    # so a caller inside the server can ask "which landmass is this post on".
    payload = [
        {key: value for key, value in island.items() if key != "post_ids"}
        for island in named
    ]
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
    return {
        "ok": True,
        "seed_count": len(state["seed_coords"]),
        "regions": len(state["islands"]),
        "store": state["store"].backend,
        "store_ok": store_ok,
        "posts": posts,
        "model_version": state["seed_map"]["meta"]["model_version"],
    }


@app.get("/api/islands")
def islands(response: Response):
    payload = live_islands()
    # Everyone looking at the map wants the same answer, and it changes on a
    # timer rather than per viewer. Worth a CDN hop if one is ever put in front.
    response.headers["Cache-Control"] = "public, max-age=30"
    return {"islands": payload}


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
        return state["store"].add_comment(payload.post_id, user_id, body)
    except StoreError:
        raise HTTPException(status_code=404, detail="投稿が見つかりませんでした。")


@app.delete("/api/local/comments/{comment_id}")
def local_delete_comment(comment_id: str, request: Request):
    require_local()
    user_id = current_user(request)
    if not state["store"].delete_comment(comment_id, user_id):
        raise HTTPException(status_code=403, detail="削除できませんでした。")
    return {"ok": True}


@app.post("/api/local/reactions")
def local_add_reaction(payload: ReactionChange, request: Request):
    require_local()
    user_id = current_user(request)
    created = state["store"].add_reaction(payload.post_id, user_id, payload.kind)
    return {"ok": True, "created": created}


@app.delete("/api/local/reactions")
def local_remove_reaction(post_id: str, kind: str, request: Request):
    require_local()
    user_id = current_user(request)
    return {"ok": state["store"].remove_reaction(post_id, user_id, kind)}


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

    try:
        return {"account": state["store"].upsert_account(user_id, fields)}
    except StoreError:
        raise HTTPException(status_code=503, detail="保存に失敗しました。もう一度お試しください。")


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
