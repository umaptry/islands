"""埋め込みバックエンドの比較台。開発者が手で走らせるオフライン専用。

    python scripts/benchmark_embeddings.py       # ローカル構成だけ

APIキーは .env（.gitignore 済み）に置くか、環境変数で渡します。GEMINI_API_KEY か
GOOGLE_API_KEY があれば Gemini を、OPENAI_API_KEY があれば OpenAI を測ります。
キーが無ければその提供元を飛ばすだけで、ローカル構成の結果は出ます。

`app.py` からは一切参照されず、serving image にも入りません。

なぜこれがあるか
----------------
「似てるやつほど低く出る」という指摘の原因は符号の反転ではなく、密ベクトルが
cos 0.85〜0.91 という極細のコーンに潰れていること（異方性）でした。そこから
「1500次元以上ないとうまく分布しない」という仮説が出たので、それを測って決着
させるのがこのスクリプトです。

決定的なのは *同じモデルを切り詰めたスイープ* です。

  - 大きいモデルを 256次元に切り詰めても、小さいモデルの 1536次元を上回るか？
      上回る -> 効くのは次元数ではなくモデルの質
  - 同一モデル内で 128 -> 3072 と上げたとき、どこで頭打ちになるか？
      これで「1500次元以上必要」が本当かどうかが直接見える

この2軸が交差して初めて、次元の効果とモデルの効果を分離できます。

Gemini を測るときに気をつけること
---------------------------------
gemini-embedding-2 には、エラーにならないまま結果を壊す挙動が2つあります。

1. contents に複数の入力をそのまま並べると、入力ごとではなく *集約された1本* が
   返ります。1件ずつ types.Content で包むと1件1本になります。gemini_fetch は
   包んだうえで、返ってきた本数が送った件数と合っているか毎回数えます。
2. task_type パラメータは受け付けません。タスクは本文の接頭辞で伝えます
   （"task: sentence similarity | query: ..."）。接頭辞を変えると入力文が変わる
   ので、GEMINI_TASKS の各要素は別々に取得して別の行として並べます。

なお gemini-embedding-001 と -2 の埋め込み空間は互換性がありません。当然いまの
448次元とも比較できないので、乗り換えるなら全件を埋め直すことになります。

コストと呼び出し回数
--------------------
どちらのモデルも Matryoshka なので「先頭を切って再正規化」が公式の切り詰めと同じ
です。したがって最大次元で1回だけ取得すれば、スイープ点はローカルで切り出せます。

ただしその前提自体が崩れるとスイープが丸ごと無効になるので、推奨次元をひとつ実API
で取得し、ローカル導出と一致するかを必ず検算します（--no-verify で省略可）。
取得した生ベクトルは artifacts/benchmark_cache/ にキャッシュされます。
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
import hashlib  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import pickle  # noqa: E402
import time  # noqa: E402

import re  # noqa: E402
from collections import deque  # noqa: E402

import httpx  # noqa: E402
import numpy as np  # noqa: E402
from scipy.stats import rankdata  # noqa: E402
from sklearn.preprocessing import normalize  # noqa: E402

import build_seed_map as build  # noqa: E402

from core.config import DENSE_WEIGHT, FEATURE_CONFIG, SPARSE_WEIGHT  # noqa: E402
from core.features import build_hybrid_features  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

PROBE_PATH = ROOT / "scripts" / "probe_topics.jsonl"
CACHE_DIR = ROOT / "artifacts" / "benchmark_cache"
RESULTS_JSON = ROOT / "artifacts" / "benchmark_results.json"
ENV_FILE = ROOT / ".env"

SPARSE_DIM = FEATURE_CONFIG["svd_components"]
OPENAI_URL = "https://api.openai.com/v1/embeddings"
BATCH = 256
RETRIES = 3
RETRY_STATUS = {408, 429, 500, 502, 503, 504}
# 429 は失敗ではなく「待て」なので、Gemini 側は粘ります。
GEMINI_RETRIES = 8
# 無料枠は embed_content の *1件ごと* に 100/分。少し下で回して余裕を持たせます。
GEMINI_ITEMS_PER_MINUTE = 90

# (モデル, 最大次元, スイープする dimensions)
OPENAI_MODELS = [
    ("text-embedding-3-small", 1536, [256, 512, 1024, 1536]),
    ("text-embedding-3-large", 3072, [256, 512, 1024, 1536, 3072]),
]
GEMINI_MODELS = [
    ("gemini-embedding-2", 3072, [128, 256, 768, 1536, 3072]),
]
# gemini-embedding-2 は task_type を受け付けず、タスクを本文の接頭辞で伝えます。
# このアプリは対称の用途を2つ持っている（似てる度＝文の類似、地図＝クラスタリング）
# ので、どちらの接頭辞が似てる度に効くのかは測らないと分かりません。
# 接頭辞を変えると入力文そのものが変わるため、これは取得を1回ずつ増やす軸です。
GEMINI_TASKS = ["sentence similarity", "clustering"]
# Contents をいくつ束ねて1リクエストにするか。上限が公表されていないので、
# 400 が返ったら自動で半分に割って測り直します（fetch_in_batches を参照）。
GEMINI_BATCH = 64

VERIFY_SAMPLE = 8
VERIFY_TOLERANCE = 1e-6

# APIを使うときに分布測定へ回すシードの件数。300件でも44,850ペアあり、p5/p50/p95
# は十分に安定します。全1,000件だと Gemini の無料枠を1つの接頭辞で使い切ります。
DEFAULT_SEED_SAMPLE = 300


# --------------------------------------------------------------------------
# 指標
# --------------------------------------------------------------------------

def gram_of(vectors):
    unit = normalize(np.asarray(vectors, dtype=np.float64))
    return unit @ unit.T


def auc(positive, negative):
    """同topicペアが異topicペアより高くなる確率。同点は0.5として数える。

    コサインの絶対値がモデルごとに全く違う（ローカルは0.7前後、OpenAIは0.3前後）
    ので、スケールに依存しないこの値を主指標にします。
    """
    if not len(positive) or not len(negative):
        return float("nan")
    ranks = rankdata(np.concatenate([positive, negative]))
    won = ranks[: len(positive)].sum() - len(positive) * (len(positive) + 1) / 2.0
    return float(won / (len(positive) * len(negative)))


def score_probe(vectors, labels, partners):
    """ラベル付きプローブでの精度。`partners` は1人あたりの真の仲間の人数。"""
    gram = gram_of(vectors)
    count = len(labels)
    self_mask = np.eye(count, dtype=bool)

    ranking = gram.copy()
    ranking[self_mask] = -np.inf
    top1 = float((labels[ranking.argmax(1)] == labels).mean())

    order = np.argsort(-ranking, axis=1)[:, :partners]
    precision = float(np.mean([(labels[order[i]] == labels[i]).mean() for i in range(count)]))

    same_mask = (labels[:, None] == labels[None, :]) & ~self_mask
    diff_mask = labels[:, None] != labels[None, :]
    same, diff = gram[same_mask], gram[diff_mask]
    return {
        "top1": top1,
        "precision_at_k": precision,
        "auc": auc(same, diff),
        "same": float(same.mean()),
        "diff": float(diff.mean()),
        "gap": float(same.mean() - diff.mean()),
    }


def score_spread(vectors):
    """シードコーパスでの分布。「うまく分布しない」を直接見るための表。"""
    gram = gram_of(vectors)
    pairs = gram[np.triu_indices(len(gram), k=1)]
    np.fill_diagonal(gram, -2.0)
    nearest = gram.max(axis=1)
    p5, p50, p95 = (float(value) for value in np.percentile(pairs, [5, 50, 95]))
    nn50 = float(np.percentile(nearest, 50))
    return {"pair_p5": p5, "pair_p50": p50, "pair_p95": p95,
            "nn_p50": nn50, "usable_range": nn50 - p5}


def top_pairs(vectors, texts, limit=10):
    """最も似ていると判定されたペアの実文面。数字だけでは足りないので目で見る。"""
    gram = np.triu(gram_of(vectors), k=1)
    flat = np.argsort(gram, axis=None)[::-1][:limit]
    found = []
    for position in flat:
        left, right = np.unravel_index(position, gram.shape)
        found.append({"cosine": round(float(gram[left, right]), 4),
                      "a": texts[left][:44], "b": texts[right][:44]})
    return found


# --------------------------------------------------------------------------
# ベクトルの組み立て
# --------------------------------------------------------------------------

def split_blocks(hybrid):
    """保存形式の448次元から dense / sparse を復元する。

    hybrid = normalize(hstack([dense * 0.65, sparse * 0.35])) なので、前後を
    それぞれ再正規化すれば元のブロックがそのまま戻ります（実測誤差 2e-08）。
    """
    hybrid = np.asarray(hybrid, dtype=np.float64)
    return normalize(hybrid[:, :-SPARSE_DIM]), normalize(hybrid[:, -SPARSE_DIM:])


def centered(vectors, centroid):
    """重心を引いてから再正規化する。異方性で潰れたコーンを広げる。"""
    vectors = np.asarray(vectors, dtype=np.float64)
    residual = vectors - centroid
    norms = np.linalg.norm(residual, axis=1)
    # 重心の真上に乗った文だけは引くと消えるので、その行だけ素のまま残す。
    degenerate = norms < 1e-6
    if degenerate.any():
        residual[degenerate] = vectors[degenerate]
    return normalize(residual)


def fuse(dense, sparse):
    """現行と同じ重みで2つのブロックを繋ぐ。"""
    return normalize(np.hstack([normalize(dense) * DENSE_WEIGHT,
                                normalize(sparse) * SPARSE_WEIGHT]))


# --------------------------------------------------------------------------
# 埋め込みAPI
# --------------------------------------------------------------------------

def load_env_file(path=ENV_FILE):
    """.env の KEY=value を環境変数に流し込む。読み込めた名前だけを返す。

    .env は既に .gitignore にあります。python-dotenv を足すほどの処理ではないので
    ここで読みます。既に環境にある変数は上書きしません（その場限りで
    `$env:GEMINI_API_KEY = "..."` と指定したほうが .env より強い、という順序）。

    返すのは名前だけで、値は返しませんし表示もしません。値そのものが鍵なので、
    端末やログに一度出れば履歴に残ります。
    """
    if not path.exists():
        return []
    loaded = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("export "):
            line = line[len("export "):].strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        name, value = name.strip(), value.strip().strip('"').strip("'")
        if name and value and not os.environ.get(name):
            os.environ[name] = value
            loaded.append(name)
    return loaded


class ItemRateLimiter:
    """1分あたり `per_minute` 件までに絞る。単位は *リクエスト数ではなく件数*。

    Gemini の無料枠は embed_content_free_tier_requests を **埋め込み1件ごとに**
    数えます。実測: プローブ100件を2リクエスト（64件+36件）で送ったところ、
    RPM がちょうど 100/100 に張り付いて 429 になりました。束ねてもクォータは
    減らないので、束ねる数ではなく件数で待つ必要があります。
    """

    def __init__(self, per_minute):
        self.per_minute = per_minute
        self.spent = deque()  # 直近1分に消費した (時刻, 件数)

    def _drop_old(self, now):
        while self.spent and now - self.spent[0][0] >= 60.0:
            self.spent.popleft()

    def take(self, count):
        while True:
            now = time.monotonic()
            self._drop_old(now)
            used = sum(amount for _, amount in self.spent)
            if used + count <= self.per_minute or not self.spent:
                self.spent.append((now, count))
                return
            wait = 60.0 - (now - self.spent[0][0]) + 0.5
            print(f"        レート制限: {wait:.0f}秒待ちます"
                  f"（直近1分で {used} 件 / 上限 {self.per_minute}）")
            time.sleep(wait)

    def refund(self, count):
        """失敗した分は消費していないので戻す。"""
        if self.spent and self.spent[-1][1] >= count:
            timestamp, amount = self.spent.pop()
            if amount > count:
                self.spent.append((timestamp, amount - count))


_RETRY_AFTER = re.compile(r"retry in ([\d.]+)s|'retryDelay': '(\d+)s'")


def retry_delay_from(message, attempt):
    """429 が指定してきた待ち時間。書いていなければ指数バックオフ。"""
    found = _RETRY_AFTER.search(message)
    if found:
        return float(found.group(1) or found.group(2)) + 1.0
    return float(2 ** attempt)


def fetch_in_batches(texts, size, call, label, checkpoint=None, limiter=None):
    """`call(chunk)` を束ねて回す。束が大きすぎて弾かれたら半分に割って続ける。

    1リクエストに詰められる件数は公表されていないので、上限を推測して固定するより、
    弾かれたら割るほうが壊れません。

    `checkpoint` があれば束ごとに呼びます。無料枠が1日1,000件しかない相手では、
    途中で落ちたときに取得済みを捨てて取り直すのがいちばん高くつくので、進捗は
    その都度ディスクに置きます。
    """
    vectors = []
    start = 0
    while start < len(texts):
        chunk = texts[start:start + size]
        if limiter is not None:
            limiter.take(len(chunk))
        try:
            vectors.extend(call(chunk))
        except ValueError:  # 束が大きすぎる。割って測り直す。
            if limiter is not None:
                limiter.refund(len(chunk))
            if len(chunk) == 1:
                raise
            size = max(1, len(chunk) // 2)
            print(f"        束が大きすぎたので {size} 件に分割します")
            continue
        start += len(chunk)
        if checkpoint is not None:
            checkpoint(vectors)
        print(f"        {label}: {start}/{len(texts)}")
    return np.asarray(vectors, dtype=np.float64)


def openai_fetch(texts, model, api_key, dimensions=None, checkpoint=None):
    def call(chunk):
        body = {"model": model, "input": chunk}
        if dimensions is not None:
            body["dimensions"] = dimensions
        last = None
        for attempt in range(RETRIES):
            try:
                response = httpx.post(
                    OPENAI_URL, json=body,
                    headers={"Authorization": f"Bearer {api_key}"}, timeout=180.0,
                )
                if response.status_code in RETRY_STATUS:
                    last = f"HTTP {response.status_code}"
                    time.sleep(2 ** attempt)
                    continue
                if response.status_code == 400:
                    raise ValueError(response.text[:200])
                response.raise_for_status()
                rows = sorted(response.json()["data"], key=lambda row: row["index"])
                return [row["embedding"] for row in rows]
            except httpx.HTTPError as error:  # ネットワーク側の一時障害も同じ扱い
                last = str(error)
                if attempt == RETRIES - 1:
                    break
                time.sleep(2 ** attempt)
        raise RuntimeError(f"OpenAI への {RETRIES} 回の試行がすべて失敗しました: {last}")

    return fetch_in_batches(texts, BATCH, call, model, checkpoint)


def gemini_prompt(text, task):
    """gemini-embedding-2 にタスクを伝える言い方。

    このモデルは task_type パラメータを受け付けないので、本文の接頭辞で伝えます。
    接頭辞を変えると入力文そのものが変わり、そこから測ったアンカーも意味を失うので、
    取得する側は必ずこの1か所を通します（別の場所で打ち直さない）。
    """
    return f"task: {task} | query: {text}"


def gemini_fetch(texts, model, api_key, dimensions=None, checkpoint=None):
    """Gemini の埋め込み。1件につき1本返させるのがこの関数の主な仕事。

    gemini-embedding-2 は contents に複数の入力を「そのまま」並べると、入力ごとの
    エンベディングではなく *集約された1本* を返します。エラーにはならないので、
    OpenAI の input=[...] と同じつもりで書くと全員が同じベクトルになり、似てる度が
    一律 100% になって初めて気づくことになります。1件ずつ Content で包むと、その
    包みごとに1本返ります。返ってきた本数は毎回数えて突き合わせます。
    """
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    config = types.EmbedContentConfig(output_dimensionality=dimensions) \
        if dimensions is not None else None

    def call(chunk):
        wrapped = [types.Content(parts=[types.Part.from_text(text=text)]) for text in chunk]
        last = None
        for attempt in range(GEMINI_RETRIES):
            try:
                result = client.models.embed_content(
                    model=model, contents=wrapped, config=config)
            except Exception as error:  # SDK の例外型はコード側から見分けられない
                message = str(error)
                if "400" in message or "INVALID_ARGUMENT" in message:
                    raise ValueError(message[:200])
                last = message
                if attempt == GEMINI_RETRIES - 1:
                    break
                # 429 は失敗ではなく「待て」なので、言われた時間だけ待って続けます。
                # 諦めて落ちると、取得済みのぶんまで無料枠を捨てることになります。
                delay = retry_delay_from(message, attempt)
                reason = "レート制限" if "429" in message else "一時的な失敗"
                print(f"        {reason}: {delay:.0f}秒待って再試行します"
                      f"（{attempt + 1}/{GEMINI_RETRIES}）")
                time.sleep(delay)
                continue
            values = [embedding.values for embedding in result.embeddings]
            if len(values) != len(chunk):
                raise RuntimeError(
                    f"{len(chunk)} 件送って {len(values)} 本返りました。"
                    "集約されている可能性があります（Content で包めていない）。")
            return values
        raise RuntimeError(
            f"Gemini への {GEMINI_RETRIES} 回の試行がすべて失敗しました: {last}")

    return fetch_in_batches(texts, GEMINI_BATCH, call, model, checkpoint,
                            ItemRateLimiter(GEMINI_ITEMS_PER_MINUTE))


def cached_embed(texts, label, fetch):
    """最大次元での埋め込み。テキストか接頭辞が変わればキャッシュは自動で無効。

    途中まで取れていれば、その続きだけを取りに行きます。無料枠が1日1,000件しか
    ない相手では、落ちるたびに取得済みを捨てて取り直すのがいちばん高くつきます。
    """
    digest = hashlib.sha256("\n".join(texts).encode("utf-8")).hexdigest()[:16]
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / f"{label}-{digest}.npy"
    done = np.load(path) if path.exists() else None
    if done is not None and len(done) >= len(texts):
        print(f"      キャッシュを使用: {path.name}")
        return done[:len(texts)]
    if done is not None:
        print(f"      途中まで取得済み: {len(done)}/{len(texts)} 件。続きから取ります。")

    def checkpoint(partial):
        merged = list(partial) if done is None else list(done) + list(partial)
        np.save(path, np.asarray(merged, dtype=np.float64))

    fresh = fetch(texts[0 if done is None else len(done):], checkpoint=checkpoint)
    if done is None:
        return np.asarray(fresh, dtype=np.float64)
    return np.asarray(np.vstack([done, fresh]), dtype=np.float64)


def truncate(vectors, dimensions):
    """`dimensions` / `output_dimensionality` と同じ操作：先頭を切って再正規化。"""
    return normalize(np.asarray(vectors, dtype=np.float64)[:, :dimensions])


def verify_truncation(texts, label, full, fetch, verify_dim):
    """ローカル導出が実APIの切り詰めと一致するかの検算。スイープの前提。"""
    served = normalize(fetch(texts[:VERIFY_SAMPLE], verify_dim))
    derived = truncate(full[:VERIFY_SAMPLE], verify_dim)
    difference = float(np.abs(served - derived).max())
    verdict = "OK" if difference < VERIFY_TOLERANCE else "NG"
    print(f"      [{verdict}] {verify_dim}次元の検算: max abs diff = "
          f"{difference:.2e} (許容 {VERIFY_TOLERANCE:.0e})")
    return difference < VERIFY_TOLERANCE, difference


# --------------------------------------------------------------------------
# 出力
# --------------------------------------------------------------------------

def pad(label, width=44):
    """全角を2桁として数えた見た目の幅で揃える。"""
    seen = sum(2 if ord(character) > 0x2E80 else 1 for character in label)
    return label + " " * max(1, width - seen)


def print_accuracy(rows, width=44):
    print(f"{pad('構成', width)}{'次元':>6}{'top1':>7}{'P@k':>7}{'AUC':>7}"
          f"{'same':>8}{'diff':>8}{'gap':>7}")
    print("-" * (width + 50))
    for row in rows:
        score = row["accuracy"]
        print(f"{pad(row['label'], width)}{row['dim']:>6}{score['top1']:>7.2f}"
              f"{score['precision_at_k']:>7.2f}{score['auc']:>7.3f}"
              f"{score['same']:>+8.3f}{score['diff']:>+8.3f}{score['gap']:>7.3f}")


def print_spread(rows, width=44):
    print(f"{pad('構成', width)}{'次元':>6}{'p5':>8}{'p50':>8}{'p95':>8}"
          f"{'NNp50':>8}{'実効幅':>8}")
    print("-" * (width + 46))
    for row in rows:
        spread = row.get("spread")
        if spread is None:
            continue
        print(f"{pad(row['label'], width)}{row['dim']:>6}{spread['pair_p5']:>+8.3f}"
              f"{spread['pair_p50']:>+8.3f}{spread['pair_p95']:>+8.3f}"
              f"{spread['nn_p50']:>+8.3f}{spread['usable_range']:>8.3f}")


# --------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="埋め込みバックエンドを同じ物差しで比較します")
    parser.add_argument("--no-gemini", action="store_true", help="Gemini を測らない")
    parser.add_argument("--no-openai", action="store_true", help="OpenAI を測らない")
    parser.add_argument("--no-verify", action="store_true",
                        help="dimensions の検算APIコールを省く")
    parser.add_argument("--no-seed", action="store_true",
                        help="シードの分布測定を省く（プローブだけ）")
    parser.add_argument("--seed-sample", type=int, default=None,
                        help=f"分布測定に使うシードの件数（既定: APIを使うなら"
                             f"{DEFAULT_SEED_SAMPLE}、ローカルだけなら全件）")
    parser.add_argument("--gemini-tasks", default="sentence similarity",
                        help="Gemini のタスク接頭辞をカンマ区切りで。"
                             "増やすとそのぶん無料枠を消費します "
                             f"（選べるのは {', '.join(GEMINI_TASKS)}）")
    arguments = parser.parse_args()

    from_file = load_env_file()
    if from_file:
        print(f"[0/4] .env から読み込みました: {', '.join(from_file)}")

    if not PROBE_PATH.exists():
        print(f"[NG] プローブがありません: {PROBE_PATH}")
        return 1
    if not build.VECTORIZERS_PICKLE.exists():
        print(f"[NG] artifacts がありません: {build.ARTIFACTS}")
        return 1

    probe_texts, probe_labels = build.load_corpus(PROBE_PATH)
    labels = np.asarray(probe_labels)
    per_topic = np.bincount(np.unique(labels, return_inverse=True)[1])
    if per_topic.min() != per_topic.max():
        print(f"[NG] トピックごとの人数が揃っていません: {per_topic}")
        return 1
    partners = int(per_topic[0] - 1)
    print(f"[1/4] プローブ {len(probe_texts)} 件 / {len(per_topic)} トピック"
          f"（1人あたりの真の仲間 {partners} 人）")

    gemini_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    openai_key = os.environ.get("OPENAI_API_KEY")
    use_gemini = bool(gemini_key) and not arguments.no_gemini
    use_openai = bool(openai_key) and not arguments.no_openai

    seed_texts = [] if arguments.no_seed else build.load_corpus(build.CORPUS_PATH)[0]
    # 無料枠は1日1,000件なので、シード全件は「1つの接頭辞で1日分」を意味します。
    # 分布のパーセンタイルは数百件（=数万ペア）あれば十分安定するため、APIを使う
    # ときは既定で間引きます。間引いた同じ部分集合をローカル行にも使うので、表の
    # 中で行ごとに母集団が変わることはありません。
    sample = arguments.seed_sample
    if sample is None and (use_gemini or use_openai):
        sample = DEFAULT_SEED_SAMPLE
    if seed_texts and sample and sample < len(seed_texts):
        picked = np.random.default_rng(42).choice(len(seed_texts), sample, replace=False)
        seed_texts = [seed_texts[index] for index in sorted(picked)]
    if seed_texts:
        print(f"      シードコーパス {len(seed_texts)} 件"
              f"（{len(seed_texts) * (len(seed_texts) - 1) // 2:,} ペア）")

    print("[2/4] ローカル448次元を構築中（学習はしません / fit_sparse=False）...")
    with open(build.VECTORIZERS_PICKLE, "rb") as handle:
        sparse_artifacts = pickle.load(handle)
    model = load_embedder()

    def local_hybrid(texts):
        hybrid, _tokens, _zero, _ = build_hybrid_features(
            texts, model, fit_sparse=False, sparse_artifacts=sparse_artifacts)
        return np.asarray(hybrid, dtype=np.float64)

    probe_hybrid = local_hybrid(probe_texts)
    probe_dense, probe_sparse = split_blocks(probe_hybrid)
    seed_hybrid = local_hybrid(seed_texts) if seed_texts else None
    if seed_hybrid is not None:
        seed_dense, seed_sparse = split_blocks(seed_hybrid)
        local_centroid = seed_dense.mean(axis=0)
    else:  # シードを測らないときはプローブ自身の重心で代用する
        seed_dense = seed_sparse = None
        local_centroid = probe_dense.mean(axis=0)

    error = float(np.abs(fuse(probe_dense, probe_sparse) - probe_hybrid).max())
    print(f"      ブロック復元の誤差: {error:.2e}（これが大きいと以下の分解は無意味）")

    rows = []

    def add(label, probe_vectors, seed_vectors, dim):
        row = {"label": label, "dim": int(dim),
               "accuracy": score_probe(probe_vectors, labels, partners)}
        if seed_vectors is not None:
            row["spread"] = score_spread(seed_vectors)
            row["top_pairs"] = top_pairs(seed_vectors, seed_texts)
        rows.append(row)

    probe_dense_c = centered(probe_dense, local_centroid)
    seed_dense_c = None if seed_dense is None else centered(seed_dense, local_centroid)
    add("L1 出荷中ハイブリッド（現状）", probe_hybrid, seed_hybrid, probe_hybrid.shape[1])
    add("L2 出荷中 + 密ブロック中心化",
        fuse(probe_dense_c, probe_sparse),
        None if seed_dense_c is None else fuse(seed_dense_c, seed_sparse),
        probe_hybrid.shape[1])
    add("L3 密ブロックのみ", probe_dense, seed_dense, probe_dense.shape[1])
    add("L4 密ブロック中心化のみ", probe_dense_c, seed_dense_c, probe_dense_c.shape[1])
    add("L5 疎ブロックのみ", probe_sparse, seed_sparse, SPARSE_DIM)

    providers = []
    if use_gemini:
        tasks = [task.strip() for task in arguments.gemini_tasks.split(",") if task.strip()]
        unknown = [task for task in tasks if task not in GEMINI_TASKS]
        if unknown:
            print(f"[NG] 知らないタスク接頭辞です: {unknown}。選べるのは {GEMINI_TASKS}")
            return 1
        providers.append({
            "name": "Gemini", "models": GEMINI_MODELS, "tasks": tasks,
            "verify_dim": 768, "short": lambda n: n.replace("gemini-embedding-", "gemini-"),
            "quota": f"無料枠 {GEMINI_ITEMS_PER_MINUTE}件/分に絞って実行、1日1,000件",
            "fetch": lambda texts, model, dim=None, checkpoint=None:
                gemini_fetch(texts, model, gemini_key, dim, checkpoint),
        })
    if use_openai:
        providers.append({
            "name": "OpenAI", "models": OPENAI_MODELS, "tasks": [None],
            "verify_dim": 1024, "short": lambda n: n.replace("text-embedding-3-", "3-"),
            "quota": "件数ではなくトークンで課金",
            "fetch": lambda texts, model, dim=None, checkpoint=None:
                openai_fetch(texts, model, openai_key, dim, checkpoint),
        })

    verification = {}
    if not providers:
        print("[3/4] APIはスキップします（GEMINI_API_KEY / OPENAI_API_KEY が環境にありません）")
    else:
        # 走らせる前に、何件投げることになるのかを出します。Gemini の無料枠は
        # 埋め込み1件ごとに数えられるので、ここが1日の予算そのものになります。
        print("[3/4] 見込みの取得件数（キャッシュ済みのぶんは実際には投げません）:")
        for provider in providers:
            per_run = len(probe_texts) + len(seed_texts)
            if not arguments.no_verify:
                per_run += VERIFY_SAMPLE
            runs = len(provider["models"]) * len(provider["tasks"])
            detail = " × ".join(filter(None, [
                f"{len(provider['models'])}モデル" if len(provider["models"]) > 1 else None,
                f"{len(provider['tasks'])}接頭辞" if len(provider["tasks"]) > 1 else None,
            ]))
            head = f"{provider['name']}: {per_run * runs} 件"
            print(f"      {head}"
                  f"（{detail + ' × ' if detail else ''}"
                  f"プローブ{len(probe_texts)} + シード{len(seed_texts)}"
                  f"{' + 検算' + str(VERIFY_SAMPLE) if not arguments.no_verify else ''}）"
                  f" / {provider['quota']}")
    for provider in providers:
        print(f"[3/4] {provider['name']} を測定中...")
        for name, full_dim, sweep in provider["models"]:
            for task in provider["tasks"]:
                # 接頭辞は入力文そのものを変えるので、タスクごとに取得し直します。
                # 混ぜると「どちらの接頭辞で埋めたか」が分からない列になります。
                prepare = (lambda text: text) if task is None                     else (lambda text, task=task: gemini_prompt(text, task))
                tag = name if task is None else f"{name}-{task.replace(' ', '_')}"
                title = provider["short"](name) if task is None                     else f"{provider['short'](name)} [{task}]"
                print(f"    {tag}（最大 {full_dim} 次元で1回だけ取得）")

                def fetch(texts, dim=None, checkpoint=None, model=name, prepare=prepare):
                    return provider["fetch"](
                        [prepare(text) for text in texts], model, dim, checkpoint)

                probe_full = cached_embed(probe_texts, tag, fetch)
                seed_full = cached_embed(seed_texts, tag, fetch) if seed_texts else None

                if not arguments.no_verify:
                    passed, difference = verify_truncation(
                        probe_texts, tag, probe_full, fetch, provider["verify_dim"])
                    verification[tag] = {"max_abs_diff": difference, "passed": bool(passed)}
                    if not passed:
                        print(f"      [NG] {tag} の切り詰めが実APIと一致しません。"
                              "この行のスイープは信用できないので飛ばします。")
                        continue

                for dimensions in sweep:
                    if dimensions > probe_full.shape[1]:
                        continue
                    probe_vectors = truncate(probe_full, dimensions)
                    seed_vectors = None if seed_full is None else truncate(seed_full, dimensions)
                    base = probe_vectors if seed_vectors is None else seed_vectors
                    centroid = base.mean(axis=0)

                    probe_c = centered(probe_vectors, centroid)
                    seed_c = None if seed_vectors is None else centered(seed_vectors, centroid)
                    add(f"{title} @{dimensions} (a)素のまま",
                        probe_vectors, seed_vectors, dimensions)
                    add(f"{title} @{dimensions} (b)中心化", probe_c, seed_c, dimensions)
                    add(f"{title} @{dimensions} (c)中心化+疎.35",
                        fuse(probe_c, probe_sparse),
                        None if seed_c is None else fuse(seed_c, seed_sparse),
                        dimensions + SPARSE_DIM)

    print()
    print("=" * 94)
    print(f"(A) 精度 — プローブ {len(probe_texts)} 件 / {len(per_topic)} トピック"
          f"（P@k の k = {partners}）")
    print("    AUC = 同topicペアが異topicペアより高く出る確率。スケール非依存の主指標。")
    print("=" * 94)
    print_accuracy(rows)

    if seed_texts:
        print()
        print("=" * 90)
        print(f"(B) 分布 — シード {len(seed_texts)} 件 "
              f"({len(seed_texts) * (len(seed_texts) - 1) // 2:,} ペア)")
        print("    実効幅 = NNp50 - pair p5。0〜100の目盛りに使える幅。")
        print("=" * 90)
        print_spread(rows)

        best = max(rows, key=lambda row: row["accuracy"]["auc"])
        print()
        print(f"[{best['label'].strip()}] が最も似ていると判定したシードのペア:")
        for pair in (best.get("top_pairs") or [])[:5]:
            print(f"  {pair['cosine']:+.4f}  {pair['a']}")
            print(f"          {pair['b']}")

    print()
    print("[4/4] 結果を書き出します")
    payload = {
        "probe": {"path": PROBE_PATH.name, "count": len(probe_texts),
                  "topics": len(per_topic), "partners": partners},
        "seed_count": len(seed_texts),
        "block_recovery_error": error,
        "truncation_verification": verification,
        "rows": rows,
    }
    with open(RESULTS_JSON, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    print(f"      artifacts/{RESULTS_JSON.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
