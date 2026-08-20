"""ことばの地図 - API and static host.

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
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from core.clustering import assign_cluster
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

RATE_LIMIT_WINDOW = 300  # seconds
RATE_LIMIT_MAX = 3
# Local development and tests populate many profiles from one address.
RATE_LIMIT_OFF = os.environ.get("KOTOBA_DISABLE_RATE_LIMIT") == "1"
NEIGHBOR_COUNT = 3

_URL = re.compile(r"https?://\S+|www\.\S+", re.IGNORECASE)
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")

state = {}
_rate_log = defaultdict(deque)
_rate_lock = threading.Lock()


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
    return {
        "seed_map": seed_map,
        "encoder": encoder,
        "scale_bounds": scale_bounds,
        "sparse_artifacts": sparse_artifacts,
        "seed_coords": seed[:, :2],
        "seed_clusters": seed[:, 2].astype(int),
        "islands": seed_map["islands"],
        "quantiles": seed_map["distance_quantiles"],
        "idf": seed_map["idf"],
    }


@asynccontextmanager
async def lifespan(_app):
    from sentence_transformers import SentenceTransformer

    print("artifacts を読み込み中...", flush=True)
    state.update(load_artifacts())
    print(f"埋め込みモデルを読み込み中: {MODEL_NAME}", flush=True)
    state["model"] = SentenceTransformer(MODEL_NAME)
    state["store"] = create_store()
    print(
        f"準備完了: seed={len(state['seed_coords'])}点 / "
        f"islands={len(state['islands'])} / store={state['store'].backend}",
        flush=True,
    )
    yield


app = FastAPI(title="ことばの地図", lifespan=lifespan, docs_url=None, redoc_url=None)


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


def island_of(cluster_id):
    for island in state["islands"]:
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
    return {
        "ok": True,
        "seed_count": len(state["seed_coords"]),
        "islands": len(state["islands"]),
        "store": state["store"].backend,
        "model_version": state["seed_map"]["meta"]["model_version"],
    }


@app.get("/api/map")
def get_map():
    """Terrain + islands + everyone currently on the map. No profile text."""
    return {
        "seed": state["seed_map"]["seed"],
        "islands": state["islands"],
        "users": state["store"].list_public(),
        "quantiles": state["quantiles"],
        "meta": {
            "seed_count": state["seed_map"]["meta"]["seed_count"],
            "max_users": MAX_USERS,
        },
    }


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
        others = [entry for entry in store.list_full() if entry["id"] != row["id"]]
    except StoreError as error:
        raise HTTPException(status_code=503, detail=f"保存に失敗しました: {error}")

    origin = {"x": x, "y": y}
    neighbors = rank_neighbors(origin, others, state["quantiles"], limit=NEIGHBOR_COUNT)
    farthest = farthest_neighbor(origin, others, state["quantiles"])

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
    try:
        target = store.get(profile_id)
    except StoreError as error:
        raise HTTPException(status_code=503, detail=str(error))
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
            me = store.get(viewer)
        except StoreError:
            me = None
        if me:
            distance = distance_between((me["x"], me["y"]), (target["x"], target["y"]))
            similarity = similarity_percent(distance, state["quantiles"])
            shared = shared_keywords(me.get("terms") or [], target.get("terms") or [], state["idf"])
            result.update({
                "distance": round(distance, 2),
                "similarity": similarity,
                "shared": shared,
                "note": describe_relation(similarity, shared),
            })
    return result


@app.post("/api/leave")
def leave(payload: LeaveRequest):
    try:
        removed = state["store"].delete(payload.id, payload.edit_token)
    except StoreError as error:
        raise HTTPException(status_code=503, detail=str(error))
    if not removed:
        raise HTTPException(status_code=403, detail="削除できませんでした。")
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
