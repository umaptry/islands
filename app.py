"""かさなり - API and static host.

Everything the server does at request time is a pure forward pass through
frozen artifacts. Nothing here fits a vectorizer, retrains an encoder, or
recomputes a layout, so joining can never move anybody who already joined.
"""

import hashlib
import io
import json
import os
import pickle
import re
import sys
import threading
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from core.clustering import assign_cluster, name_group
from core.config import (
    MAX_NAME_LENGTH,
    MAX_TEXT_LENGTH,
    MAX_USERS,
    MIN_TEXT_LENGTH,
    MODEL_NAME,
)
from core.encoder import load_encoder
from core.features import build_hybrid_features, extract_label_terms, normalize_text
from core.geometry import scale_projected_coordinate
from core.similarity import (
    cosine_between,
    cosine_percent,
    describe_relation,
    distance_between,
    farthest_neighbor,
    rank_neighbors,
    shared_keywords,
    similarity_percent,
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


# The defaults suit a link shared on the open internet. A room full of people on
# one office or venue wifi shares a single public address, so the per-IP cap has
# to be raised for a live demo or the fourth person to sign up is turned away.
# MAX_USERS is the real ceiling on how much anyone can fill the map.
RATE_LIMIT_WINDOW = _int_env("KOTOBA_RATE_LIMIT_WINDOW", 300)  # seconds
RATE_LIMIT_MAX = _int_env("KOTOBA_RATE_LIMIT_MAX", 3)
# Local development and tests populate many profiles from one address.
RATE_LIMIT_OFF = os.environ.get("KOTOBA_DISABLE_RATE_LIMIT") == "1"
NEIGHBOR_COUNT = 3

_URL = re.compile(r"https?://\S+|www\.\S+", re.IGNORECASE)
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")

state = {}
_rate_log = defaultdict(deque)
_rate_lock = threading.Lock()
# Island names are derived from the posts that are on the map right now, so they
# change whenever the map changes and stay put whenever it does not. The cache
# key is the set of posts; recomputing costs one extra query, so it happens on a
# join or a leave rather than on every poll.
_islands_cache = {"key": None, "value": []}
_islands_lock = threading.Lock()

# The 448-dim vectors, cached under the same rule as the islands. /api/map is
# polled every few seconds and pulling 200 x 448 floats out of PostgREST each
# time would be the most expensive thing the server does, for data that cannot
# change: a row's vector is written at join and never updated.
_vectors_cache = {"key": None, "value": {}}
_vectors_lock = threading.Lock()
# Held across the fetch itself, so a room full of people polling at the same
# moment after somebody joins produces one query rather than one each.
_vectors_fetch_lock = threading.Lock()


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
    # The client frames the camera on the corpus but no longer draws it, so it
    # needs the extent and not the 1,000 points. Sending the points cost ~9KB
    # gzipped on every 15-second poll, for pixels nobody sees.
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
        # Absent in artifacts built before similarity moved off the map
        # distance. None means every similarity path falls back to the 2-D
        # measure, which is the old behaviour, so an old artifact still boots.
        "cosine_anchors": seed_map.get("cosine_anchors"),
        "idf": seed_map["idf"],
    }


@asynccontextmanager
async def lifespan(_app):
    from core.embedder import load_embedder

    print("artifacts を読み込み中...", flush=True)
    state.update(load_artifacts())
    print(f"埋め込みモデルを読み込み中: {MODEL_NAME} (ONNX)", flush=True)
    state["model"] = load_embedder()
    state["store"] = create_store()
    if state["store"].backend == "memory":
        # Easy to miss otherwise: the app works perfectly, and then a Space
        # restart silently erases everyone who joined.
        rule = "!" * 70
        for line in (
            "",
            rule,
            "[警告] SUPABASE_URL / SUPABASE_SERVICE_KEY が未設定です。",
            "       プロフィールはメモリ上にのみ保存され、再起動で全て消えます。",
            "       ローカル開発では正常です。公開環境なら Secret を設定してください。",
            rule,
            "",
        ):
            print(line, flush=True)
    limit = "無効" if RATE_LIMIT_OFF else f"{RATE_LIMIT_MAX}回/{RATE_LIMIT_WINDOW}秒"
    print(
        f"準備完了: seed={len(state['seed_coords'])}点 / "
        f"領域={len(state['islands'])} / store={state['store'].backend} / "
        f"定員={MAX_USERS}人 / 参加制限={limit}",
        flush=True,
    )
    yield


app = FastAPI(title="かさなり", lifespan=lifespan, docs_url=None, redoc_url=None)

# The free egress allowance on the deploy target is 1GiB/month, and web/app.js
# is highly compressible text: 30KB -> ~9KB. minimum_size skips the small JSON
# replies, where the header would cost more than the compression saves.
# (/api/map used to be the other fat response until it stopped shipping the
# 1,000 seed points; it is now a couple of KB.)
app.add_middleware(GZipMiddleware, minimum_size=1024)


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

class JoinRequest(BaseModel):
    icon_id: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH)
    text: str = Field(min_length=1)


class LeaveRequest(BaseModel):
    id: str
    edit_token: str


class LikeRequest(BaseModel):
    id: str
    edit_token: str
    to_id: str


class InboxRequest(BaseModel):
    id: str
    edit_token: str


def client_key(request: Request):
    forwarded = request.headers.get("x-forwarded-for", "")
    address = forwarded.split(",")[0].strip() or (request.client.host if request.client else "?")
    return hashlib.sha256(address.encode()).hexdigest()[:16]


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


def _island_signature(users):
    """Cheap fingerprint of who is on the map, from data /api/map already has."""
    return (len(users), max((user["created_at"] for user in users), default=""))


def live_islands(users):
    """Islands named by the people standing on them.

    The regions themselves are still the frozen ones - which region a post
    belongs to is decided by assign_cluster against the seed layout, and none of
    that moves. What is generated here is the NAME, from the words of the posts
    in each region, and the position, from where those posts actually are. A
    region nobody has posted in has no name and is not sent: the map starts empty
    and grows names as people arrive, rather than presenting a set of genres that
    nobody has written anything for.
    """
    if not users:
        return []

    key = _island_signature(users)
    with _islands_lock:
        if _islands_cache["key"] == key:
            return _islands_cache["value"]

    try:
        rows = state["store"].list_terms()
    except StoreError:
        # Keep whatever was last computed rather than blanking the map.
        with _islands_lock:
            return _islands_cache["value"]

    grouped = defaultdict(list)
    for row in rows:
        grouped[int(row["cluster_id"])].append(row)

    # Name the biggest island first: when two islands would pick the same word,
    # the one with more people behind it has the better claim to it.
    islands = []
    taken = []
    for cluster_id, members in sorted(
        grouped.items(), key=lambda item: (-len(item[1]), item[0])
    ):
        name = name_group([row.get("terms") for row in members], state["idf"], taken)
        if not name:
            continue
        taken.append(name)
        islands.append({
            "id": cluster_id,
            "name": name,
            "cx": round(sum(float(row["x"]) for row in members) / len(members), 2),
            "cy": round(sum(float(row["y"]) for row in members) / len(members), 2),
            "size": len(members),
        })

    islands.sort(key=lambda island: island["id"])
    with _islands_lock:
        _islands_cache["key"] = key
        _islands_cache["value"] = islands
    return islands


def invalidate_islands():
    with _islands_lock:
        _islands_cache["key"] = None
    with _vectors_lock:
        _vectors_cache["key"] = None


def user_vectors(users):
    """{id: vec} for everyone on the map, or {} if they cannot be fetched.

    Keyed by the same signature as the islands, so a join refreshes both. An
    unreachable store returns {} rather than raising: similarity then falls back
    to the map distance and the map still draws.
    """
    if state.get("cosine_anchors") is None:
        return {}
    key = _island_signature(users)
    with _vectors_lock:
        if _vectors_cache["key"] == key:
            return _vectors_cache["value"]

    with _vectors_fetch_lock:
        # Somebody else may have filled it while we waited for the lock.
        with _vectors_lock:
            if _vectors_cache["key"] == key:
                return _vectors_cache["value"]
        try:
            rows = state["store"].list_vectors()
        except StoreError:
            return {}
        vectors = {row["id"]: row.get("vec") for row in rows}
        with _vectors_lock:
            _vectors_cache["key"] = key
            _vectors_cache["value"] = vectors
        return vectors


def viewer_similarity(viewer_id, users):
    """{other_id: 似てる度} for one viewer, or None when it cannot be computed.

    None is deliberate: the key is then left out of the response entirely and
    the client keeps using its own map-distance fallback, rather than being
    handed a half-populated table.
    """
    anchors = state.get("cosine_anchors")
    if anchors is None or not viewer_id:
        return None
    vectors = user_vectors(users)
    mine = vectors.get(viewer_id)
    if mine is None:
        return None
    similarity = {}
    for user in users:
        if user["id"] == viewer_id:
            continue
        cosine = cosine_between(mine, vectors.get(user["id"]))
        if cosine is None:
            return None
        similarity[user["id"]] = cosine_percent(cosine, anchors)
    return similarity


def island_of(cluster_id):
    """The island a post belongs to, as it is named right now.

    Reads the cache directly when it is warm. Going through live_islands() would
    mean a list_public() on every profile the sheet opens, purely to compute a
    cache key that has not changed.
    """
    with _islands_lock:
        islands = _islands_cache["value"] if _islands_cache["key"] is not None else None
    if islands is None:
        try:
            islands = live_islands(state["store"].list_public())
        except StoreError:
            islands = []
    for island in islands:
        if island["id"] == cluster_id:
            return island
    return None


def project(text):
    """text -> (x, y, cluster_id, terms, vector). The only place text becomes position.

    Note the two different term sets. The 448-dim vector is built from nouns,
    verbs AND adjectives, because verbs carry meaning. The `terms` returned for
    storage are NOUNS ONLY, because they exist purely to be shown back to a
    reader as shared-keyword chips, and a chip row led by 揃える reads worse than
    one led by 焚き火. Same reasoning as extract_label_terms.
    """
    features, _token_lists, zero_rows, _ = build_hybrid_features(
        [text], state["model"], fit_sparse=False, sparse_artifacts=state["sparse_artifacts"]
    )
    if zero_rows:
        raise HTTPException(
            status_code=422,
            detail="意味のある単語が見つかりませんでした。もう少し具体的に書いてみてください。",
        )
    raw = state["encoder"](features[0])
    x, y = scale_projected_coordinate(float(raw[0]), float(raw[1]), state["scale_bounds"])
    cluster_id = assign_cluster(x, y, state["seed_coords"], state["seed_clusters"])
    return round(x, 2), round(y, 2), int(cluster_id), extract_label_terms(text), features[0]


def annotate(viewer_terms, entry):
    """Attach shared keywords to a neighbour entry."""
    shared = shared_keywords(viewer_terms, entry.get("terms") or [], state["idf"])
    return {
        "id": entry["id"],
        "icon_id": entry["icon_id"],
        "name": entry["name"],
        "x": entry["x"],
        "y": entry["y"],
        "cluster_id": entry["cluster_id"],
        "text": entry.get("text", ""),
        "distance": entry["distance"],
        "similarity": entry["similarity"],
        "shared": shared,
        "note": describe_relation(entry["similarity"], shared),
    }


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------

@app.get("/api/health")
def health():
    # count() is a HEAD against PostgREST, and it is here on purpose: the
    # keep-alive ping hits this route, and a Supabase free project suspends
    # itself after 7 idle days. Touching the database keeps both halves of the
    # deployment awake with one request. A store that is down must not take
    # health down with it - the answer is still useful without the count.
    try:
        users = state["store"].count()
        store_ok = True
    except StoreError:
        users = None
        store_ok = False
    return {
        "ok": True,
        "seed_count": len(state["seed_coords"]),
        "islands": len(state["islands"]),
        "store": state["store"].backend,
        "store_ok": store_ok,
        "users": users,
        "model_version": state["seed_map"]["meta"]["model_version"],
    }


@app.get("/api/map")
def get_map(viewer: str = ""):
    """Terrain + islands + everyone currently on the map. No profile text.

    `viewer` adds a {id: 似てる度} table for that one person, so the orbit view
    places people by the same measure the profile sheet prints. The vectors
    themselves never leave the server.
    """
    # The store has already retried by the time it raises. Turning that into a
    # 503 with a sentence a visitor can act on beats a bare 500, and the client
    # retries this call on its own.
    try:
        users = state["store"].list_public()
    except StoreError:
        raise HTTPException(
            status_code=503, detail="地図の読み込みに失敗しました。少し待ってからもう一度お試しください。"
        )
    try:
        counts = state["store"].like_counts()
    except StoreError:
        counts = {}
    payload = {
        "seed_bounds": state["seed_bounds"],
        "islands": live_islands(users),
        "users": users,
        "like_counts": counts,
        "quantiles": state["quantiles"],
        "meta": {
            "seed_count": state["seed_map"]["meta"]["seed_count"],
            "max_users": MAX_USERS,
        },
    }
    similarity = viewer_similarity(viewer, users)
    if similarity is not None:
        payload["similarity"] = similarity
    return payload


@app.post("/api/join")
def join(payload: JoinRequest, request: Request):
    name = payload.name.strip()
    text = sanitize(normalize_text(payload.text))[:MAX_TEXT_LENGTH]

    if len(text) < MIN_TEXT_LENGTH:
        raise HTTPException(
            status_code=422,
            detail=f"自由記述は{MIN_TEXT_LENGTH}字以上でお願いします（現在{len(text)}字）。",
        )
    if not name:
        raise HTTPException(status_code=422, detail="ユーザー名を入力してください。")
    if not check_rate_limit(client_key(request)):
        raise HTTPException(status_code=429, detail="少し時間をおいてからお試しください。")

    store = state["store"]
    try:
        if store.count() >= MAX_USERS:
            raise HTTPException(status_code=409, detail=f"定員（{MAX_USERS}人）に達しました。")
        x, y, cluster_id, terms, vector = project(text)
        row = store.insert({
            "icon_id": payload.icon_id,
            "name": name,
            "text": text,
            "x": x,
            "y": y,
            "cluster_id": cluster_id,
            "terms": terms,
            "vec": [round(float(value), 6) for value in vector],
        })
        invalidate_islands()
        others = [entry for entry in store.list_full() if entry["id"] != row["id"]]
    except StoreError:
        raise HTTPException(
            status_code=503, detail="保存に失敗しました。もう一度「地図にのせる」を押してください。"
        )

    origin = {"x": x, "y": y}
    # list_full already carries every other person's vec, so ranking by the
    # 448-dim cosine costs no extra query.
    anchors = state.get("cosine_anchors")
    neighbors = rank_neighbors(
        origin, others, state["quantiles"], limit=NEIGHBOR_COUNT,
        origin_vector=vector, anchors=anchors,
    )
    farthest = farthest_neighbor(
        origin, others, state["quantiles"], origin_vector=vector, anchors=anchors,
    )

    return {
        "id": row["id"],
        "edit_token": row["edit_token"],
        "icon_id": payload.icon_id,
        "name": name,
        "text": text,
        "x": x,
        "y": y,
        "cluster_id": cluster_id,
        "island": island_of(cluster_id),
        "terms": terms,
        "neighbors": [annotate(terms, entry) for entry in neighbors],
        "farthest": annotate(terms, farthest) if farthest else None,
        "total": len(others) + 1,
    }


@app.get("/api/user/{profile_id}")
def get_user(profile_id: str, viewer: str = ""):
    store = state["store"]
    anchors = state.get("cosine_anchors")
    want_vec = bool(viewer and viewer != profile_id and anchors is not None)
    try:
        target = store.get(profile_id, with_vec=want_vec)
    except StoreError:
        raise HTTPException(status_code=503, detail="読み込みに失敗しました。もう一度お試しください。")
    if not target:
        raise HTTPException(status_code=404, detail="見つかりませんでした。")

    result = {
        "id": target["id"],
        "icon_id": target["icon_id"],
        "name": target["name"],
        "text": target["text"],
        "x": target["x"],
        "y": target["y"],
        "cluster_id": target["cluster_id"],
        "island": island_of(target["cluster_id"]),
    }

    if viewer and viewer != profile_id:
        try:
            me = store.get(viewer, with_vec=want_vec)
        except StoreError:
            me = None
        if me:
            distance = distance_between((me["x"], me["y"]), (target["x"], target["y"]))
            # Cosine when both sides have a vector, map distance otherwise. The
            # fallback is what keeps a row written before vectors existed, or a
            # store that dropped the column, from 500ing a profile open.
            cosine = cosine_between(me.get("vec"), target.get("vec")) if want_vec else None
            similarity = (
                cosine_percent(cosine, anchors)
                if cosine is not None
                else similarity_percent(distance, state["quantiles"])
            )
            shared = shared_keywords(me.get("terms") or [], target.get("terms") or [], state["idf"])
            result.update({
                "distance": round(distance, 2),
                "similarity": similarity,
                "shared": shared,
                "note": describe_relation(similarity, shared),
            })
    return result


@app.post("/api/like")
def like(payload: LikeRequest):
    """Send a like. Idempotent: liking twice is the same as liking once.

    edit_token proves the sender is who they say they are. Without it anyone
    could post likes as anybody else, and the notification names a person.
    """
    store = state["store"]
    if payload.id == payload.to_id:
        raise HTTPException(status_code=422, detail="自分にはいいねできません。")
    try:
        if not store.verify(payload.id, payload.edit_token):
            raise HTTPException(status_code=403, detail="本人確認ができませんでした。")
        created = store.add_like(payload.id, payload.to_id)
        counts = store.like_counts()
    except StoreError:
        raise HTTPException(status_code=503, detail="いいねを送れませんでした。もう一度お試しください。")
    return {"ok": True, "created": created, "total": counts.get(payload.to_id, 0)}


@app.post("/api/inbox")
def inbox(payload: InboxRequest):
    """Likes this person has received, and the ids they have already liked.

    A POST rather than a GET because edit_token would otherwise sit in a query
    string, which lands in access logs and browser history.

    Only ids come back. The client already holds every name from /api/map, so
    resolving them here would mean a join for no benefit.
    """
    store = state["store"]
    try:
        if not store.verify(payload.id, payload.edit_token):
            raise HTTPException(status_code=403, detail="本人確認ができませんでした。")
        received = store.likes_received(payload.id)
        given = store.likes_given(payload.id)
        counts = store.like_counts()
    except StoreError:
        raise HTTPException(status_code=503, detail="読み込みに失敗しました。")
    return {"received": received, "given": given, "counts": counts}


@app.post("/api/leave")
def leave(payload: LeaveRequest):
    try:
        removed = state["store"].delete(payload.id, payload.edit_token)
    except StoreError:
        raise HTTPException(status_code=503, detail="削除に失敗しました。もう一度お試しください。")
    if not removed:
        raise HTTPException(status_code=403, detail="削除できませんでした。")
    invalidate_islands()
    return {"ok": True}


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


class RevalidatingStatics(StaticFiles):
    """Serve assets with `no-cache` so a redeploy actually reaches returning users.

    `no-cache` does not mean "do not cache" - it means "revalidate before use".
    The browser still keeps the file and still gets a cheap 304 when nothing
    changed, but it can never serve a stale app.js against a new index.html.
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
