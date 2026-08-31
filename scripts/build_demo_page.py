"""本番の実投稿で、似てる度のエンジンを切り替えて見比べる1枚のHTMLを作る。

    python scripts/build_demo_page.py --fetch-live   # 本番から一度だけ取得
    python scripts/build_demo_page.py --verify       # ゲートだけ回す（HTMLは書かない）
    python scripts/build_demo_page.py                # demo/engines.html を書き出す

開発者が手で走らせるスクリプトです。`app.py` からは参照されず、`.dockerignore` /
`.gcloudignore` で serving image からも除外してあります。

┌───────────────────────────────────────────────────────────────────────────┐
│ ⚠ このスクリプトは islands 化で動かなくなりました（未移植）。             │
│                                                                           │
│ 前提にしていたものが2つとも無くなっています:                              │
│   - 1ファイルのフロント `web/app.js`（`web/js/` 以下のESモジュール群に分割）│
│   - 旧API `/api/map` `/api/user/{id}` `/api/join` `/api/like` `/api/inbox` │
│     （`map_posts` RPC と `/api/posts` `/api/neighbors` `/api/pair` に置換）│
│                                                                           │
│ 移植するなら `scripts/demo_shim.js` を `web/js/net.js` の `data` 面と      │
│ `api` 面に対して書き直すのが本体です。エンジン比較そのもの（E1〜E4 と      │
│ ゲートA〜C）のロジックは今も有効なので、通信の差し替え方だけの問題です。   │
│                                                                           │
│ 似てる度エンジンの比較だけが目的なら、移植を待たずに                      │
│ `python scripts/benchmark_embeddings.py` が使えます（こちらは無傷）。      │
└───────────────────────────────────────────────────────────────────────────┘

作るもの
--------
本物の UI（web/index.html / app.js / style.css / avatars.js）をそのまま1ファイルに畳み、
通信だけを焼き込んだデータに差し替えます。プルダウンで切り替わるのは4つ:

  E1 デプロイ済み           448次元コサイン（中心化なし）＋旧アンカー   位置は本番のまま
  E2 中心化                 448次元コサイン＋中心化＋新アンカー         位置は本番のまま
  E3 Gemini（似てる度だけ） gemini-embedding-2 @768 中心化             位置は本番のまま
  E4 Gemini（地図ごと）     同上                                       UMAPで引き直し

なぜ再計算できるのか
--------------------
公開APIは `vec` を返しません。しかし `app.project(text)` は同じ文章から同じ448次元
ベクトルと同じ座標を決定的に作るので、テキストから作り直せます。しかも
**再計算した x,y が本番の x,y と一致すれば、ベクトルも本番のものと同一である証明**に
なります（座標はベクトルの決定的な関数なので、21点が偶然そろうことはない）。これが
ゲートAです。

費用について
------------
本番へのリクエストは初回の34回だけで、あとは demo/cache/ から読みます。Gemini は
21件だけ。無料枠は埋め込み1件ごとに 100/分・1,000/日 で数えられます。
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

# onnxruntime を scipy/sklearn より先に読む。逆順だと Windows で共有ライブラリが
# 衝突して "DLL load failed while importing onnxruntime_pybind11_state" になる。
from core.embedder import load_embedder  # noqa: E402  isort:skip

import argparse  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import os  # noqa: E402
import pickle  # noqa: E402
import re  # noqa: E402
import time  # noqa: E402

import httpx  # noqa: E402
import numpy as np  # noqa: E402

from core.clustering import assign_cluster  # noqa: E402
from core.config import CLUSTER_VOTE_K  # noqa: E402
from core.encoder import load_encoder  # noqa: E402
from core.features import (  # noqa: E402
    build_hybrid_features,
    extract_label_terms,
)
from core.geometry import scale_projected_coordinate  # noqa: E402
from core.similarity import (  # noqa: E402
    cosine_between,
    cosine_percent,
    describe_relation,
    resolve_scale,
    shared_keywords,
)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

BASE = "https://kotoba-map-315170697037.us-central1.run.app"
ARTIFACTS = ROOT / "artifacts"
WEB = ROOT / "web"
DEMO = ROOT / "demo"
CACHE = DEMO / "cache"

LIVE_MAP = CACHE / "live_map.json"
LIVE_USERS = CACHE / "live_users.json"
LIVE_PAIRS = CACHE / "live_pairs.json"
OUT_HTML = DEMO / "engines.html"

ORACLE_PAIRS = 12
ORACLE_SEED = 7
TIMEOUT = 30.0

# describe_relation の戻り値は4通りしかない。ペアごとに文字列を持つと純粋な重複で
# 数十KBになるので、この表への添字だけを焼き込む。
NOTES = [
    None,
    "同じ語は使っていませんが、意味は近いです。",
    "同じ語はまだありません。",
    "重なるところは見つかりませんでした。",
]
NOTE_INDEX = {text: index for index, text in enumerate(NOTES)}


# ビルド時のゲートの結果。端末に出すだけでなく HTML にも焼き込んで、
# 開いた人がスクリプトを走らせずに同じ確認をできるようにする。
GATES = []


def say(message):
    print(message, flush=True)


def gate(letter, title, detail, ok=True, rows=None):
    """ゲート1件の結果を記録して、そのまま端末にも出す。"""
    GATES.append({"id": letter, "title": title, "detail": detail,
                  "ok": bool(ok), "rows": rows or []})
    say(f"[ゲート{letter}] {title}: {detail}")
    return ok


# --------------------------------------------------------------------------
# 1. 本番スナップショット
# --------------------------------------------------------------------------

def get_json(client, path):
    response = client.get(f"{BASE}{path}", timeout=TIMEOUT)
    response.raise_for_status()
    return response.json()


def fetch_live(refetch=False):
    """本番から一度だけ取る。以降はキャッシュを読む。"""
    CACHE.mkdir(parents=True, exist_ok=True)
    if LIVE_PAIRS.exists() and not refetch:
        say(f"      キャッシュを使用: {CACHE.relative_to(ROOT)}/live_*.json")
        return

    with httpx.Client() as client:
        health = get_json(client, "/api/health")
        say(f"      /api/health -> users={health.get('users')} "
            f"store={health.get('store')} model={health.get('model_version')}")
        # 手元の artifacts と本番のビルドが揃っていなければ、以降の再計算は無意味。
        if health.get("model_version") != "kotoba-map-v1":
            raise SystemExit(f"[NG] model_version が想定と違います: {health.get('model_version')}")

        live_map = get_json(client, "/api/map")
        users = live_map["users"]
        say(f"      /api/map -> {len(users)}人 / 島{len(live_map['islands'])}")

        detail = {}
        for index, user in enumerate(users, 1):
            detail[user["id"]] = get_json(client, f"/api/user/{user['id']}")
            say(f"        本文を取得 {index}/{len(users)}")

        # E1 の答え合わせ用。本番が返す似てる度そのものを持ち帰る。
        ids = [user["id"] for user in users]
        rng = np.random.default_rng(ORACLE_SEED)
        pairs, seen = [], set()
        while len(pairs) < min(ORACLE_PAIRS, len(ids) * (len(ids) - 1)):
            a, b = (str(ids[i]) for i in rng.choice(len(ids), 2, replace=False))
            if (a, b) in seen:
                continue
            seen.add((a, b))
            pairs.append({"target": a, "viewer": b,
                          **get_json(client, f"/api/user/{a}?viewer={b}")})
            say(f"        答え合わせ用 {len(pairs)}/{ORACLE_PAIRS}")

    LIVE_MAP.write_text(json.dumps(live_map, ensure_ascii=False), encoding="utf-8")
    LIVE_USERS.write_text(json.dumps(detail, ensure_ascii=False), encoding="utf-8")
    LIVE_PAIRS.write_text(json.dumps(pairs, ensure_ascii=False), encoding="utf-8")
    say(f"      {len(users) + len(pairs) + 2} 回のリクエストで取得完了。以降はキャッシュを読みます。")


def load_live():
    if not LIVE_PAIRS.exists():
        raise SystemExit("[NG] スナップショットがありません。--fetch-live を先に実行してください。")
    return (json.loads(LIVE_MAP.read_text(encoding="utf-8")),
            json.loads(LIVE_USERS.read_text(encoding="utf-8")),
            json.loads(LIVE_PAIRS.read_text(encoding="utf-8")))


# --------------------------------------------------------------------------
# 2. ベクトルの再計算（ゲートA / B）
# --------------------------------------------------------------------------

def recompute(live_map, live_users):
    """本文から448次元ベクトルと座標を作り直し、本番の座標と突き合わせる。"""
    seed_map = json.loads((ARTIFACTS / "seed_map.json").read_text(encoding="utf-8"))
    encoder, scale_bounds = load_encoder(ARTIFACTS / "encoder.npz")
    with open(ARTIFACTS / "vectorizers.pkl", "rb") as handle:
        sparse_artifacts = pickle.load(handle)

    order = [user["id"] for user in live_map["users"]]
    texts = [live_users[uid]["text"] for uid in order]
    features, _tokens, zero_rows, _ = build_hybrid_features(
        texts, load_embedder(), fit_sparse=False, sparse_artifacts=sparse_artifacts)
    if zero_rows:
        raise SystemExit(f"[NG] 内容語が残らない本文が {zero_rows} 件あります。")

    vectors, coords, mismatched = {}, {}, []
    for uid, vector in zip(order, np.asarray(features, dtype=np.float64)):
        raw = encoder(vector)
        x, y = scale_projected_coordinate(float(raw[0]), float(raw[1]), scale_bounds)
        x, y = round(x, 2), round(y, 2)
        vectors[uid] = vector
        coords[uid] = (x, y)
        live = live_users[uid]
        if (x, y) != (live["x"], live["y"]):
            mismatched.append((uid, x, y, live["x"], live["y"]))

    gate("A", "本文から作り直した座標が本番と一致",
         f"{len(order) - len(mismatched)}/{len(order)} 一致"
         "（座標はベクトルの決定的な関数なので、これは再計算ベクトル＝本番の vec の証明）",
         ok=not mismatched)
    if mismatched:
        for uid, x, y, lx, ly in mismatched[:5]:
            say(f"        {uid[:8]} 再計算({x}, {y}) vs 本番({lx}, {ly}) "
                f"差 ({abs(x - lx):.2f}, {abs(y - ly):.2f})")
        raise SystemExit(
            "[NG] 手元の artifacts が本番のビルドと違います。全員一律のずれなら "
            "scale_bounds、バラバラなら vectorizers.pkl か埋め込みモデルの不一致です。")

    terms = {uid: extract_label_terms(live_users[uid]["text"]) for uid in order}
    return seed_map, order, vectors, terms


def gate_b(order, terms, idf, live_pairs):
    """本番が返した shared チップを、手元の語抽出で再現できるか。"""
    bad = []
    for pair in live_pairs:
        target, viewer = pair["target"], pair["viewer"]
        if target not in terms or viewer not in terms or "shared" not in pair:
            continue
        mine = shared_keywords(terms[viewer], terms[target], idf)
        if mine != pair["shared"]:
            bad.append((viewer, target, pair["shared"], mine))
    gate("B", "共有していることばの再現",
         f"{len(live_pairs) - len(bad)}/{len(live_pairs)} 一致", ok=not bad)
    for viewer, target, live, mine in bad[:3]:
        say(f"        {viewer[:8]}→{target[:8]} 本番={live} 手元={mine}")
    if bad:
        raise SystemExit("[NG] 語の抽出が本番と食い違っています（Sudachi かストップワードの差）。")


# --------------------------------------------------------------------------
# 3. エンジン
# --------------------------------------------------------------------------

# いま本番で動いているビルドが持っているアンカー。中心化を入れる前の
# build_similarity_calibration.py が、中心化していない448次元のシード全ペアから
# 測った値そのもの（5%点 / 最近傍中央値、499,500ペア）。
#
# git から読んでいた時期があったが、中心化をコミットした時点で HEAD が新しい
# アンカーに変わり、E1 が E1 でなくなった。履歴の位置に依存させず、正しさは
# ゲートC（本番が返す値との突き合わせ）に持たせる。本番を作り直してここが古く
# なれば、ゲートCが実際の数値の差として落ちる。
DEPLOYED_ANCHORS = {
    "cosine_floor": 0.64297,
    "cosine_ceiling": 0.874266,
    "floor_percentile": 5.0,
    "ceiling_percentile": 50.0,
    "pair_count": 499500,
}


def pairwise(order, vectors, anchors, centroid):
    """全ペアの似てる度。app.py:597-603 と同じ呼び出し列を通す。"""
    table = {uid: {} for uid in order}
    for i, a in enumerate(order):
        for b in order[i + 1:]:
            cosine = cosine_between(vectors[a], vectors[b], centroid)
            percent = cosine_percent(cosine, anchors)
            table[a][b] = table[b][a] = percent
    return table


def notes_for(order, shared, sim):
    """ボトムシートの一言。共有語は共通でも似てる度で変わるのでエンジンごとに持つ。"""
    note = {uid: {} for uid in order}
    for i, a in enumerate(order):
        for b in order[i + 1:]:
            index = NOTE_INDEX[describe_relation(sim[a][b], shared[a][b])]
            note[a][b] = note[b][a] = index
    return note


def gate_c(sim_e1, live_pairs):
    """E1 は対照群。本番の返す整数と1つでも違えば、比較全体が成り立たない。"""
    rows, bad = [], 0
    for pair in live_pairs:
        if "similarity" not in pair:
            continue
        live = pair["similarity"]
        mine = sim_e1[pair["viewer"]][pair["target"]]
        rows.append((pair["viewer"][:8], pair["target"][:8], live, mine))
        bad += int(live != mine)
    gate("C", "E1 の似てる度が本番サーバーの返す値と一致",
         f"{len(rows) - bad}/{len(rows)} 完全一致"
         "（E1 は対照群なので、ここが合って初めて他3つとの差に意味が出る）",
         ok=not bad,
         rows=[{"視点": v, "相手": t, "本番": live, "E1": mine} for v, t, live, mine in rows])
    if bad:
        say(f"        {'視点':<10}{'相手':<10}{'本番':>6}{'E1':>6}{'差':>6}")
        for viewer, target, live, mine in rows:
            if live != mine:
                say(f"        {viewer:<10}{target:<10}{live:>6}{mine:>6}{mine - live:>6}")
        raise SystemExit("[NG] E1 が本番を再現できていません。アンカーかベクトルが違います。")


def spread(order, sim):
    values = [sim[a][b] for i, a in enumerate(order) for b in order[i + 1:]]
    return float(np.mean(values)), float(np.std(values))


def gate_k(engines):
    """似てる度は対称でなければならない。添字のとり違えを潰すための安い自己点検。"""
    for key, engine in engines.items():
        sim = engine["sim"]
        for a, row in sim.items():
            for b, value in row.items():
                if sim[b][a] != value:
                    raise SystemExit(f"[NG] {key} の似てる度が非対称です: {a[:8]}/{b[:8]}")
    gate("K", "似てる度の対称性", f"{len(engines)}エンジンすべて OK")


# --------------------------------------------------------------------------
# 3b. Gemini（E3 / E4）
# --------------------------------------------------------------------------

E4_LAYOUT = CACHE / "e4_layout.npy"


def gemini_vectors(order, live_users):
    """21人ぶんと、目盛りの土台になるシード300件を768次元で揃える。

    接頭辞は `benchmark_embeddings.gemini_prompt` を必ず通します。ここで打ち直すと
    シード側と1文字でも違ったときにアンカーの意味が消えますが、エラーにはならず
    数字だけが静かにずれます。
    """
    import benchmark_embeddings as bench
    import build_seed_map as build

    bench.load_env_file()
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        say("      [スキップ] GEMINI_API_KEY が無いので E3 / E4 は作りません。")
        return None

    task = bench.GEMINI_TASKS[0]
    tag = f"gemini-embedding-2-{task.replace(' ', '_')}"

    def fetch(texts, dim=None, checkpoint=None):
        return bench.gemini_fetch(
            [bench.gemini_prompt(text, task) for text in texts],
            "gemini-embedding-2", key, dim, checkpoint)

    seed_all, _ = build.load_corpus(build.CORPUS_PATH)
    picked = sorted(np.random.default_rng(42).choice(
        len(seed_all), bench.DEFAULT_SEED_SAMPLE, replace=False))
    seed_texts = [seed_all[index] for index in picked]

    say(f"      接頭辞: {bench.gemini_prompt('…', task)}")
    seed_raw = bench.cached_embed(seed_texts, tag, fetch)          # 既存キャッシュに当たる
    user_raw = bench.cached_embed([live_users[uid]["text"] for uid in order], tag, fetch)

    seed768 = bench.truncate(seed_raw, 768)
    user768 = bench.truncate(user_raw, 768)
    centroid = seed768.mean(axis=0)
    return {
        "seed": bench.centered(seed768, centroid),
        "users": bench.centered(user768, centroid),
        "seed_texts": seed_texts,
        "task": task,
    }


def gemini_anchors(seed_centered):
    """目盛りをシード300件から測る。出荷中と同じ 5%点 / 最近傍中央値の決め方。"""
    import build_similarity_calibration as calib

    anchors, _quantiles, _pairs, _nearest = calib.measure(seed_centered)
    anchors["space"] = "gemini-768-centered"
    anchors["seed_sample"] = int(len(seed_centered))

    # ゲートD: 300件は出荷中の499,500ペアより2桁少ない。200件で30回引き直して振れ幅を見る。
    rng = np.random.default_rng(11)
    floors, ceilings = [], []
    for _ in range(30):
        index = rng.choice(len(seed_centered), 200, replace=False)
        sampled, *_ = calib.measure(seed_centered[index])
        floors.append(sampled["cosine_floor"])
        ceilings.append(sampled["cosine_ceiling"])
    swing = float(np.std(ceilings))
    gate("D", "Gemini の目盛りの安定性（300件から200件を30回引き直し）",
         f"0%の基準 ±{np.std(floors):.4f} / 100%の基準 ±{swing:.4f}"
         f"{'（±0.02 以内なので注意書きは不要）' if swing <= 0.02 else '（振れが大きい）'}",
         ok=True)
    caveat = None
    if swing > 0.02:
        caveat = (f"目盛りはシード{len(seed_centered)}件から測っています"
                  f"（出荷中は1,000件）。100%の基準が ±{swing:.3f} 揺れるので、"
                  "%の絶対値は目安として見てください。")
        say(f"        振れ幅が大きいので画面に注意書きを出します。")
    return anchors, caveat


def gemini_layout(gemini, order, terms, idf):
    """E4 の座標と島。app.py の配置経路をそのまま写す。"""
    from sklearn.cluster import KMeans

    from core.clustering import name_group, sort_clusters_by_position
    from core.config import LAYOUT_CONFIG
    from core.geometry import isotropic_scale_coordinates, nearest_neighbor_stats

    seed_count = len(gemini["seed"])
    combined = np.vstack([gemini["seed"], gemini["users"]])

    if E4_LAYOUT.exists():
        say(f"      キャッシュを使用: {E4_LAYOUT.name}")
        scaled = np.load(E4_LAYOUT)
        # 一度検証した配置をそのまま使い回している。ここを黙って飛ばすと、
        # パネルからゲートEだけが消えて「測っていない」ように見えてしまう。
        gate("E", "E4 の UMAP が再現する",
             f"検証済みの配置を {E4_LAYOUT.name} から読んでいます"
             "（作り直しても地図が動かないよう固定）")
    else:
        import umap

        def project():
            return umap.UMAP(n_components=2, **LAYOUT_CONFIG).fit_transform(combined)

        say(f"      UMAP をシード{seed_count}件＋{len(order)}人＝{len(combined)}件に当てます")
        first = project()
        # ゲートE: 再現しない配置だと、作り直すたびに地図が動いてしまう。
        drift = float(np.abs(project() - first).max())
        gate("E", "E4 の UMAP が再現する（2回走らせて比較）",
             f"座標の差 {drift:.2e}", ok=drift <= 1e-6)
        if drift > 1e-6:
            say("        再現しないので、この1回目の結果を固定して以降はそれを読みます。")
        scaled, _bounds = isotropic_scale_coordinates(first)
        np.save(E4_LAYOUT, scaled)

    seed_xy, user_xy = scaled[:seed_count], scaled[seed_count:]

    stats = nearest_neighbor_stats(seed_xy)
    gate("F", "E4 の配置が潰れていない",
         f"最近傍距離の p95/min = {stats['p95_over_min']:.1f}（出荷中の地図は 67.4）",
         ok=stats["p95_over_min"] >= 5)
    if stats["p95_over_min"] < 5:
        raise SystemExit("[NG] 配置が潰れています。この地図では比較になりません。")

    # 島は出荷中と同じ10個に固定する。select_cluster_model は448次元向けに
    # 調整されたゲートを持つので、ここでは通らない可能性が高い。
    labels = KMeans(n_clusters=10, n_init=20, random_state=42).fit_predict(seed_xy)
    labels, _order = sort_clusters_by_position(labels, seed_xy, 10)

    positions, grouped = {}, {}
    for uid, (x, y) in zip(order, user_xy):
        cluster_id = int(assign_cluster(float(x), float(y), seed_xy, labels, k=CLUSTER_VOTE_K))
        positions[uid] = {"x": round(float(x), 2), "y": round(float(y), 2),
                          "cluster_id": cluster_id}
        grouped.setdefault(cluster_id, []).append(uid)

    # live_islands と同じ順序・同じ taken の引き回し。大きい島から名前を取る。
    islands, taken = [], []
    for cluster_id, members in sorted(grouped.items(), key=lambda item: (-len(item[1]), item[0])):
        name = name_group([terms[uid] for uid in members], idf, taken)
        if not name:
            continue
        taken.append(name)
        islands.append({
            "id": cluster_id, "name": name,
            "cx": round(sum(positions[uid]["x"] for uid in members) / len(members), 2),
            "cy": round(sum(positions[uid]["y"] for uid in members) / len(members), 2),
            "size": len(members),
        })
    islands.sort(key=lambda island: island["id"])

    seed_bounds = [float(seed_xy[:, 0].min()), float(seed_xy[:, 1].min()),
                   float(seed_xy[:, 0].max()), float(seed_xy[:, 1].max())]
    say(f"      島 {len(islands)}個: {', '.join(i['name'] for i in islands)}")
    return positions, islands, seed_bounds


# --------------------------------------------------------------------------
# 4. 単一HTMLの組み立て
# --------------------------------------------------------------------------

IMPORT_LINE = "import { EMOJI, avatarCss, drawFace, paintAvatar } from './avatars.js';"


def app_script():
    """avatars.js + app.js を classic script 1本に畳む。

    書き換えるのは import/export の2箇所だけで、ロジックには一切触りません。
    classic にすると `state` と `orbitCache` が共有のグローバル字句スコープに乗るので、
    後ろに置くドライバから素の名前で触れるようになります（iframe が要らない理由）。
    """
    avatars = (WEB / "avatars.js").read_text(encoding="utf-8")
    app = (WEB / "app.js").read_text(encoding="utf-8")

    stripped = re.subn(r"^export\s+", "", avatars, flags=re.MULTILINE)
    avatars, removed = stripped[0], stripped[1]

    if IMPORT_LINE not in app:
        raise SystemExit(f"[NG] app.js の import 行が想定と違います: {IMPORT_LINE!r}")
    app = app.replace(IMPORT_LINE, "// (デモ: avatars.js を直前に連結したので import は不要)")

    imported = [name.strip() for name in
                re.search(r"\{([^}]*)\}", IMPORT_LINE).group(1).split(",")]
    combined = avatars + "\n" + app
    leftover = re.findall(r"^\s*(?:import|export)\b.*$", combined, flags=re.MULTILINE)
    # avatars.js は app.js が使わないものも公開している（avatarFor）。数を突き合わせても
    # 意味がないので、「import していた名前が全部その場に居るか」を見る。
    missing = [name for name in imported
               if not re.search(rf"^(?:const|let|var|function|async function)\s+{name}\b",
                                avatars, flags=re.MULTILINE)]

    gate("G", "app.js を classic script に畳めている",
         f"export を {removed} 個外し import 1行を除去、"
         f"残った module 構文 {len(leftover)} / 解決できない名前 {len(missing)}",
         ok=not leftover and not missing)
    if leftover:
        for line in leftover[:3]:
            say(f"        {line.strip()}")
        raise SystemExit("[NG] module 構文が残っています。classic script として動きません。")
    if missing:
        raise SystemExit(
            f"[NG] app.js が import している {missing} が avatars.js に見当たりません。"
            "連結しても未定義参照になります。")
    return combined


def build_bundle(live_map, live_users, order, terms, idf, engines, oracle):
    profiles = {}
    for uid in order:
        live = live_users[uid]
        profiles[uid] = {
            "id": uid, "icon_id": live["icon_id"], "name": live["name"],
            "text": live["text"], "created_at": next(
                u["created_at"] for u in live_map["users"] if u["id"] == uid),
        }
    shared = {uid: {} for uid in order}
    for i, a in enumerate(order):
        for b in order[i + 1:]:
            words = shared_keywords(terms[a], terms[b], idf)
            shared[a][b] = shared[b][a] = words
    return {
        "generated_at": time.strftime("%Y-%m-%d %H:%M"),
        "base_url": BASE,
        "order": order,
        "profiles": profiles,
        "shared": shared,
        "noteTable": NOTES,
        "like_counts": live_map.get("like_counts", {}),
        "quantiles": live_map["quantiles"],
        "meta": live_map["meta"],
        "engines": engines,
        # 開いた人がスクリプトを走らせずに同じ確認をできるように、ビルド時の
        # ゲート結果と、本番との答え合わせに使った実際のペアを持たせる。
        "verification": {
            "gates": GATES,
            "source": BASE,
            "users": len(order),
            "oracle": oracle,
        },
    }


def assemble(bundle, script):
    """本物の index.html / style.css / app.js を1ファイルに畳む。"""
    index = (WEB / "index.html").read_text(encoding="utf-8")
    index = re.sub(r'^\s*<link rel="stylesheet" href="/static/style\.css">\s*$\n',
                   "", index, flags=re.MULTILINE)
    index = re.sub(r'^\s*<script type="module" src="/static/app\.js"></script>\s*$\n',
                   "", index, flags=re.MULTILINE)
    if "/static/" in index:
        raise SystemExit("[NG] index.html に /static/ 参照が残っています。")

    blocks = "\n".join([
        "<style>", (WEB / "style.css").read_text(encoding="utf-8"), "</style>",
        "<style>", (ROOT / "scripts" / "demo_chrome.css").read_text(encoding="utf-8"), "</style>",
        DEMO_BAR_HTML,
        '<script type="application/json" id="demo-bundle">',
        json.dumps(bundle, ensure_ascii=False, separators=(",", ":")),
        "</script>",
        "<script>", (ROOT / "scripts" / "demo_shim.js").read_text(encoding="utf-8"), "</script>",
        "<script>", script, "</script>",
        "<script>", (ROOT / "scripts" / "demo_driver.js").read_text(encoding="utf-8"), "</script>",
    ])
    return index.replace("</body>", blocks + "\n</body>")


DEMO_BAR_HTML = """
<div class="demobar" id="demobar">
  <label class="demobar-field">
    <span>似てる度の計算</span>
    <select id="demoEngine"></select>
  </label>
  <label class="demobar-field">
    <span>自分</span>
    <select id="demoViewer"></select>
  </label>
</div>
"""


# --------------------------------------------------------------------------

def _refuse_if_unported():
    """Fail with a sentence instead of a traceback four functions deep.

    The islands rewrite removed both things this script builds on: the
    single-file front end it inlines, and the API endpoints it snapshots. It is
    better to say so at the top than to let somebody discover it from a
    FileNotFoundError on web/app.js.
    """
    if (ROOT / "web" / "app.js").exists():
        return
    print(
        "\n"
        "このスクリプトは islands 化で動かなくなっています（未移植）。\n"
        "\n"
        "  - 畳み込む対象だった web/app.js は web/js/ 以下に分割されました\n"
        "  - 取得先だった /api/map, /api/user/{id}, /api/join は廃止され、\n"
        "    map_posts RPC と /api/posts, /api/neighbors, /api/pair に変わりました\n"
        "\n"
        "移植の本体は scripts/demo_shim.js を web/js/net.js の面に書き直すことです。\n"
        "エンジン比較だけが目的なら scripts/benchmark_embeddings.py が使えます。\n",
        file=sys.stderr,
    )
    raise SystemExit(2)


def main():
    parser = argparse.ArgumentParser(description="実データでエンジンを切り替えるデモを作ります")
    parser.add_argument("--fetch-live", action="store_true", help="本番から取得（キャッシュがあれば省略）")
    parser.add_argument("--refetch", action="store_true", help="キャッシュを無視して取り直す")
    parser.add_argument("--verify", action="store_true", help="ゲートだけ回してHTMLは書かない")
    arguments = parser.parse_args()
    _refuse_if_unported()

    say("[1/6] 本番スナップショット")
    if arguments.fetch_live or arguments.refetch or not LIVE_PAIRS.exists():
        fetch_live(refetch=arguments.refetch)
    live_map, live_users, live_pairs = load_live()
    say(f"      {len(live_map['users'])}人 / 答え合わせ用ペア {len(live_pairs)}組")

    say("[2/6] 本文から448次元を作り直し")
    seed_map, order, vectors, terms = recompute(live_map, live_users)
    idf = seed_map["idf"]
    gate_b(order, terms, idf, live_pairs)

    say("[3/6] E1（デプロイ済み）")
    e1_anchors = dict(DEPLOYED_ANCHORS)
    assert resolve_scale(e1_anchors, None) == (e1_anchors, None),         "E1 は旧アンカー・中心化なしで解決されるはず"
    say(f"      E1 anchors floor={e1_anchors['cosine_floor']} "
        f"ceiling={e1_anchors['cosine_ceiling']} 中心化なし")
    sim_e1 = pairwise(order, vectors, e1_anchors, None)
    gate_c(sim_e1, live_pairs)
    mean1, sd1 = spread(order, sim_e1)
    say(f"      全{len(order) * (len(order) - 1) // 2}ペアの分布: "
        f"平均{mean1:.1f}% ばらつき{sd1:.1f}")

    # 位置と島は本番の値をそのまま使う。E1/E2 は似てる度だけが違う。
    live_positions = {uid: {"x": live_users[uid]["x"], "y": live_users[uid]["y"],
                            "cluster_id": live_users[uid]["cluster_id"]} for uid in order}
    shared = {uid: {} for uid in order}
    for i, a in enumerate(order):
        for b in order[i + 1:]:
            words = shared_keywords(terms[a], terms[b], idf)
            shared[a][b] = shared[b][a] = words

    engines = {
        "E1": {
            "label": "intfloat/multilingual-e5-small",
            "sublabel": "448次元コサイン（中心化なし）",
            "anchors": e1_anchors, "moves_map": False,
            "positions": live_positions, "islands": live_map["islands"],
            "seed_bounds": live_map["seed_bounds"],
            "sim": sim_e1, "note": notes_for(order, shared, sim_e1),
            "sheet_note": "似てる度は multilingual-e5-small の448次元で測っています。",
            "caveats": [],
        },
    }

    say("[4/6] E3 / E4（Gemini）")
    gemini = gemini_vectors(order, live_users)
    if gemini is not None:
        g_anchors, _caveat = gemini_anchors(gemini["seed"])
        say(f"      Gemini anchors floor={g_anchors['cosine_floor']:.6f} "
            f"ceiling={g_anchors['cosine_ceiling']:.6f} space={g_anchors['space']}")

        user_vecs = {uid: gemini["users"][i] for i, uid in enumerate(order)}
        sim_g = pairwise(order, user_vecs, g_anchors, None)
        g_positions, g_islands, g_bounds = gemini_layout(gemini, order, terms, idf)
        engines["E4"] = {
            "label": "gemini-embedding-2",
            "sublabel": "768次元コサイン（中心化）＋ UMAPで引き直し",
            "anchors": g_anchors, "moves_map": True,
            "positions": g_positions, "islands": g_islands,
            "seed_bounds": g_bounds,
            "sim": sim_g, "note": notes_for(order, shared, sim_g),
            "sheet_note": "似てる度も地図も gemini-embedding-2 の768次元から。",
            "caveats": [],
        }

    say("[5/6] 焼き込むデータを組み立て")
    gate_k(engines)
    # ゲートG は app.js を畳むときに立つ。bundle にその結果も入れたいので先に走らせる。
    script = app_script()
    oracle = [{"視点": pair["viewer"][:8], "相手": pair["target"][:8],
               "本番": pair.get("similarity"), "E1": sim_e1[pair["viewer"]][pair["target"]]}
              for pair in live_pairs if "similarity" in pair]
    bundle = build_bundle(live_map, live_users, order, terms, idf, engines, oracle)

    if arguments.verify:
        say("\n--verify のため HTML は書きません。ここまでのゲートはすべて通過しました。")
        return 0

    say("[6/6] 単一HTMLに畳む")
    html = assemble(bundle, script)
    DEMO.mkdir(parents=True, exist_ok=True)
    OUT_HTML.write_text(html, encoding="utf-8", newline="\n")
    say(f"      {OUT_HTML.relative_to(ROOT)}  {OUT_HTML.stat().st_size // 1024}KB "
        f"／ エンジン{len(engines)}・{len(order)}人")
    say(f"      ブラウザで開いてください: {OUT_HTML.as_uri()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
