"""地図B案の島の土台（外形・地方・お手本の近く・名前の位置・はじまりの村）。

お手本（seed_map.json の "seed"、座標 0〜1000）から純粋に計算する。起動時に1回作ってキャッシュし、
ブラウザには payload() を /api/map-b/base で渡す。格子の並びは行優先（index = j*n + i、j が y）。
"""

import base64
import hashlib
import json

import numpy as np
from scipy import ndimage
from sklearn.neighbors import KNeighborsClassifier, NearestNeighbors

from core.config import MAP_B_FOREST, MAP_B_REGIONS

X0 = Y0 = -150.0
CELL = 5.0
N = 260                 # -150〜1150 を覆う
SIGMA = 85.0            # 外形をぼかす幅（世界座標）
THRESHOLD = 0.20
MIN_COAST = 15.0        # お手本の点はこれ以上、海岸から内側にある
NEAR_SEED = 15.0        # 「お手本の近く」とみなす距離
MIN_ENCLAVE = 40        # これ未満のセルの飛び地は周りの地方に塗り替える
START_COAST = 40.0
OUTSIDE = 255

_cache = {}


def _centers():
    return np.array([[x, y] for _, x, y, _ in MAP_B_REGIONS], dtype=float)


def _axis():
    return X0 + (np.arange(N) + 0.5) * CELL


def _cell_index(xy):
    ix = np.clip(((xy[:, 0] - X0) / CELL).astype(int), 0, N - 1)
    iy = np.clip(((xy[:, 1] - Y0) / CELL).astype(int), 0, N - 1)
    return iy, ix


def _shape(seed_xy):
    """島の外形。戻り値は (mask, coast, お手本が coast>=15 にある割合, 使った閾値)。"""
    dens = np.zeros((N, N))
    iy, ix = _cell_index(seed_xy)
    np.add.at(dens, (iy, ix), 1)
    blur = ndimage.gaussian_filter(dens, SIGMA / CELL)
    blur = blur / blur.max()
    g = _axis()
    xx, yy = np.meshgrid(g, g)
    r = np.hypot(xx - 500, yy - 500)
    score = blur + 0.35 * np.clip(1 - r / 512, 0, 1)
    threshold = THRESHOLD
    while True:
        mask = score > threshold
        mask = ndimage.binary_fill_holes(ndimage.binary_opening(mask, iterations=2))
        lab, _count = ndimage.label(mask)
        mask = lab == (np.bincount(lab.ravel())[1:].argmax() + 1)
        coast = np.where(mask, ndimage.distance_transform_edt(mask),
                         -ndimage.distance_transform_edt(~mask)) * CELL
        share = float((coast[iy, ix] >= MIN_COAST).mean())
        if share >= 0.995 or threshold <= 0.02:
            return mask, coast, share, threshold
        threshold -= 0.01          # 足りなければ閾値を下げて外形を広げる


def _regions(seed_xy, mask):
    """格子の各セルの地方。お手本ごとに最も近い中心の番号を付け、KNN で塗り、小さな飛び地を消す。"""
    centers = _centers()
    d = ((seed_xy[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2)
    labels = d.argmin(axis=1)
    g = _axis()
    xx, yy = np.meshgrid(g, g)
    knn = KNeighborsClassifier(n_neighbors=15, weights="distance").fit(seed_xy, labels)
    region = knn.predict(np.c_[xx.ravel(), yy.ravel()]).reshape(N, N).astype(np.uint8)
    region[~mask] = OUTSIDE
    for rid in range(len(centers)):
        lab, count = ndimage.label(region == rid)
        if count <= 1:
            continue
        sizes = np.bincount(lab.ravel())[1:]
        keep = sizes.argmax() + 1
        for k in range(1, count + 1):
            if k == keep or sizes[k - 1] >= MIN_ENCLAVE:
                continue
            part = lab == k
            ring = ndimage.binary_dilation(part) & ~part
            around = region[ring]
            around = around[(around != OUTSIDE) & (around != rid)]
            if len(around):
                region[part] = np.bincount(around).argmax()
    return region


def _build(seed):
    seed = np.asarray(seed, dtype=float)
    seed_xy = seed[:, :2]
    mask, coast, share, threshold = _shape(seed_xy)
    region = _regions(seed_xy, mask)
    g = _axis()
    xx, yy = np.meshgrid(g, g)
    dist, _ = NearestNeighbors(n_neighbors=1).fit(seed_xy).kneighbors(np.c_[xx.ravel(), yy.ravel()])
    near = (dist[:, 0] <= NEAR_SEED).reshape(N, N).astype(np.uint8)
    # 地方の名前の位置：地方の境界と海岸の両方から遠い点
    anchors = []
    for rid, _x, _y, name in MAP_B_REGIONS:
        m = region == rid
        if not m.any():
            continue
        d = ndimage.distance_transform_edt(m) * np.minimum(1.0, np.maximum(coast, 0) / 30.0)
        j, i = np.unravel_index(d.argmax(), d.shape)
        anchors.append({"id": rid, "name": name, "x": round(float(g[i]), 1), "y": round(float(g[j]), 1)})
    # はじまりの村：(500, 512) に一番近い coast >= 40 の陸の点
    jj, ii = np.nonzero(coast >= START_COAST)
    k = ((g[ii] - 500) ** 2 + (g[jj] - 512) ** 2).argmin()
    start = {"x": round(float(g[ii[k]]), 1), "y": round(float(g[jj[k]]), 1)}
    land_j, land_i = np.nonzero(mask)
    extent = {"minX": float(X0 + land_i.min() * CELL), "minY": float(Y0 + land_j.min() * CELL),
              "maxX": float(X0 + (land_i.max() + 1) * CELL), "maxY": float(Y0 + (land_j.max() + 1) * CELL)}
    digest = hashlib.sha1()
    digest.update(np.round(seed, 3).tobytes())
    digest.update(json.dumps(MAP_B_REGIONS, ensure_ascii=False).encode("utf-8"))
    return {
        "mask": mask, "coast": coast, "region": region, "near": near, "regions": anchors,
        "start": start, "extent": extent, "version": digest.hexdigest()[:12],
        "seed_share": share, "threshold": threshold,
    }


def build(seed):
    """土台を作ってキャッシュする（起動時に1回）。"""
    _cache["base"] = _build(seed)
    _cache.pop("payload", None)
    return _cache["base"]


def base():
    return _cache.get("base")


def region_of(x, y):
    """世界座標 (x, y) の地方（0〜15）。陸の外・土台が無いときは None。"""
    b = _cache.get("base")
    if b is None:
        return None
    i = int((x - X0) // CELL)
    j = int((y - Y0) // CELL)
    if not (0 <= i < N and 0 <= j < N):
        return None
    rid = int(b["region"][j, i])
    return None if rid == OUTSIDE else rid


def region_name(rid):
    for number, _x, _y, name in MAP_B_REGIONS:
        if number == rid:
            return name
    return None


def _b64(array):
    return base64.b64encode(np.ascontiguousarray(array).tobytes()).decode("ascii")


def payload():
    """JSON 用。土台が無ければ None。"""
    b = _cache.get("base")
    if b is None:
        return None
    if "payload" not in _cache:
        coast = np.clip(np.round(b["coast"] / 4), -127, 127).astype(np.int8)
        _cache["payload"] = {
            "version": b["version"],
            "grid": {"x0": int(X0), "y0": int(Y0), "cell": int(CELL), "n": N},
            "coast": _b64(coast),
            "region": _b64(b["region"].astype(np.uint8)),
            "near": _b64(b["near"].astype(np.uint8)),
            "regions": b["regions"],
            "start": b["start"],
            "extent": b["extent"],
            "forest": MAP_B_FOREST,
        }
    return _cache["payload"]
