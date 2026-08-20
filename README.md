---
title: かさなり
emoji: 🔗
colorFrom: purple
colorTo: pink
sdk: docker
app_port: 7860
pinned: false
---

# かさなり

一言の自己紹介だけで、自分の居場所が地図の上にできる。近い人＝似た話をしている人で、
タップすると二人が共有していることばが見える。

URL を知っていれば誰でも参加できます（アカウント不要・最大100人）。

---

## 仕組みの要点

書いた文章 **だけ** が入力です。年齢も性別も居場所も使いません。

```
あなたの一文
  ├─ どの語を使ったか  Sudachiで分かち書き → 単語TF-IDF(1-2gram) ⊕ 文字TF-IDF(2-4gram)×0.25
  │                     → TruncatedSVD(64) → L2                              …… 64次元
  └─ どんな意味か      multilingual-e5-small (ONNX Runtime) で
                        「生の文」×0.35 + 「内容語だけの文」×0.65 → L2         …… 384次元

  → hstack([意味×0.65, 語×0.35]) → L2                                        …… 448次元
  → 凍結エンコーダ f (448→512→256→128→2, GELU+LayerNorm)
  → 等方スケール（x と y に同じ倍率）→ 0-1000 の座標
```

`f` は **一度だけ** 学習して凍結してあります。教師役の UMAP を1回走らせてお手本の配置を作り、
それを再現するようニューラルネットを回帰学習させ、重みを固定しました。以降の投影はすべて
純粋な順伝播なので、

- 同じ文章は毎回 **小数点まで完全に同じ座標** になり、
- 誰が新しく参加しても **既存の点は 1px も動きません**。

島（クラスタ）は、公開座標そのものに対する k-means（k は 6〜10 から自動選定）で、
名前は各島の特徴語ペアを `0.45×関連度 + 0.35×意味的近さ + 0.20×共起` で自動選定しています。

詳しい図解は起動後 `/how` にあります。

---

## ローカルで動かす

```bash
python -m pip install -r requirements.txt
python -m uvicorn app:app --reload --port 7860
```

`SUPABASE_URL` / `SUPABASE_SERVICE_KEY` が未設定のときは自動でインメモリ保存になるので、
そのまま http://localhost:7860 で一通り試せます（再起動すると消えます）。

テスト:

```bash
python -m pytest tests/ -v
```

---

## 地図を作り直す（通常は不要）

> **警告**: `build_seed_map.py` を実行するとエンコーダが再学習され、**全員の座標が変わります**。
> すでに参加した人は自分の居場所を見失います。`artifacts/` は公開後は不変として扱ってください。

シードコーパスを差し替える場合のみ:

```bash
python -m pip install -r requirements-build.txt
python scripts/validate_corpus.py          # 文字数・重複・内容語ゼロ行・文型偏りを検査
python scripts/build_seed_map.py           # 20〜30分
python scripts/build_seed_map.py --verify  # 既存ビルドの整合性だけ確認
```

### 座標を動かさずに直せること

島の名前がしっくりこないときや、地図の向きを変えたいときに、再学習は不要です。

```bash
python scripts/build_seed_map.py --relabel  # 島の分け方と名前だけ付け直す（数分）
python scripts/rotate_map.py                # 地図を90度回して縦長にする（一瞬）
```

どちらも保存済みの座標をそのまま使うため、**既存の点は1pxも動きません**
（`rotate_map.py` は書き込む前に全ペア距離が不変であることを検証します）。

島名を直したいときは、まず `core/stopwords.py` の `LABEL_ONLY_STOP_WORDS` /
`DISPLAY_STOP_WORDS` を調整してから `--relabel` を実行してください。この2つは
**ベクトルに一切影響しません**。`GENERAL_STOP_WORDS` のほうは特徴量に効くので、
触ると再ビルドが必要になります。

`scripts/seed_corpus.jsonl` は 1行1件の JSONL（UTF-8 / LF）で、`{"text": "..."}` のみ。
30字以上、内容語が2語以上残ること。同じ文型の繰り返しは避けてください（内容ではなく
**文体** で島ができます）。

ビルドは4つの品質ゲートを通らないと `artifacts/` を書きません:

| ゲート | 基準 |
|---|---|
| `mean_drift_ratio` | < 0.35（お手本の配置をどれだけ再現できたか） |
| `determinism` | 同一入力の再実行がビット一致 |
| `numpy_matches_torch` | 最大差 < 1e-5 |
| `generalization` | 60点ホールドアウトの近傍一致率 / 到達可能上限 ≥ 0.65 |

---

## デプロイ（Google Cloud Run + Supabase / どちらも無料枠）

> **Hugging Face Spaces は使えません。** 公式ドキュメントのとおり、無料で作れるのは
> Static Space と ZeroGPU Gradio Space だけで、`sdk: docker` の Space は作成に PRO
> （$9/月）が必要になりました。CPU Basic ハードウェア自体は $0/h ですが、作成権限が
> 有料プランの裏にあります。冒頭の Space 用 front-matter は、PRO を取れば現行の
> `Dockerfile` がそのまま動くので残してあります。

常駐 965MB・fp32 ONNX 448MB という重さが配信先を決めます。512MB クラスの無料枠
（Render Free / Streamlit Community / Vercel Functions）には入りません。入れるには
int8 量子化が必要で、それは下表のとおり **3割の人の「一番近い人」を変えてしまう**ため
採りません。Cloud Run は 2GiB を無料枠の範囲で使えるので、**モデルも座標も一切
妥協せずに** 公開できます。

### 1. Supabase

プロジェクトを作り、SQL エディタで `supabase/schema.sql` を実行。
`Project Settings → API` から `URL` と `service_role` キーを控えます。

### 2. Cloud Run

```bash
gcloud run deploy kotoba-map \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi --cpu 1 \
  --max-instances 1 --concurrency 40 \
  --timeout 120 --cpu-boost \
  --set-env-vars "SUPABASE_URL=https://xxxx.supabase.co,SUPABASE_SERVICE_KEY=eyJ..."
```

`service_role` キーは RLS を迂回できる強い権限です。**サーバー側だけ** が保持し、
ブラウザには一切渡しません（`profiles` は RLS 有効・ポリシー0件なので anon キーでは
何も触れません）。

### 3. 起こしておく

`.github/workflows/keepalive.yml` が10分おきに `/api/health` を叩きます。GitHub の
リポジトリ変数 `KOTOBA_MAP_URL` に Cloud Run の URL を設定してください。`/api/health`
は Supabase の件数も引くので、この1本で Cloud Run のコールドスタートと Supabase の
7日休止の両方を防げます。

### なぜこの設定なのか（無料枠を1円も超えないための条件）

| 設定 | 理由 |
|---|---|
| `--region us-central1` | 無料枠は Tier 1 リージョンのみ。日本からは +130ms 程度だが、本アプリは通信回数が少ないので体感差はほぼ無い |
| `--memory 2Gi` | 常駐 965MB + 起動時に取得する ONNX 448MB がコンテナの書き込み層（＝メモリ計上）に載る。1GiB では OOM する |
| `--max-instances 1` | 支出の上限を物理的に固定する。副次的に、`app.py` のプロセス内レートリミッタ（3 join / 300秒 / IP）が分散で骨抜きにならない |
| モデルを焼き込まない | Artifact Registry の無料枠は 0.5GB/月。焼き込むと圧縮後 ~600MB で超過する。`Dockerfile` の `ARG KOTOBA_FETCH_MODEL_AT_START` は既定 `1`（起動時取得）。イメージは圧縮後 ~180MB に収まる |
| gzip（`app.py`） | 下りの無料枠は北米 1GiB/月。実測で `app.js` 28.4KB→9.2KB、`/api/map` 20.1KB→8.8KB。初回訪問あたり約70KB→28KBになり、無料枠で捌ける来訪者が約2.5倍になる |

無料枠の内訳（月あたり）: 200万リクエスト / 180,000 vCPU秒 / 360,000 GiB秒 / 下り 1GiB。
2GiB 構成なら 360,000 ÷ 2 = **50時間ぶんのリクエスト処理時間**が無料です。アイドル中は
課金対象時間が発生しません。念のため請求先アカウントに**予算アラートを ¥1 で設定**し、
Artifact Registry には常に1イメージだけ残す運用にしてください。

### カード登録なしで試したいとき

ローカルの uvicorn に Cloudflare Quick Tunnel を被せると、アカウント不要・完全無料で
HTTPS の公開 URL が出ます。PC を起動している間だけ生きる URL なので、面談や短時間の
デモ向けです。

```bash
cloudflared tunnel --url http://localhost:7860
```

---

## 構成

```
app.py                  FastAPI（API + 静的配信）。torch を一切読み込まない
core/
  config.py             全パラメータの単一の置き場
  features.py           テキスト → 448次元
  embedder.py           multilingual-e5-small を ONNX Runtime で動かす層
  encoder.py            凍結エンコーダの numpy 実装 + .npz の読み書き
  clustering.py         島の選定と特徴語ペアの命名
  geometry.py           等方スケール / 完全重複の分離
  similarity.py         距離→似てる度% / 共通キーワード
  store.py              Supabase（PostgREST）とインメモリの2実装
  stopwords.py          自己紹介ドメイン向けストップワード
scripts/
  seed_corpus.jsonl     シード1,000件
  validate_corpus.py    ビルド前の検査
  build_seed_map.py     凍結マップ構築（1回だけ実行）/ --relabel / --verify
  rotate_map.py         既存マップを90度回転（縦画面向け・座標の距離は不変）
  train_parametric.py   torch を使う唯一のモジュール（学習専用）
artifacts/              seed_map.json / vectorizers.pkl / encoder.npz
web/                    index.html / app.js / style.css / avatars.js / how.html
```

### 配信スタックに torch が入らない理由

埋め込みは `core/embedder.py` が **ONNX Runtime** で、凍結エンコーダは `core/encoder.py` が
**numpy** で動かします。結果、配信イメージに torch も umap-learn も入りません。

| | メモリ | イメージ |
|---|---|---|
| sentence-transformers + torch | 約1,250MB | 約1.9GB |
| **ONNX Runtime + numpy** | **約965MB** | **約900MB** |

**なぜ int8 ではなく fp32 か。** `intfloat/multilingual-e5-small` は int8 量子化版
（112.9MB / fp32 は 448.5MB）も配布しています。シード300件で実測したところ:

| | torchとのコサイン | 近傍15件の一致率 | 最近傍が同一 |
|---|---|---|---|
| ONNX fp32 | 1.00000 | 1.0000 | 1.000 |
| ONNX int8 | 0.99563 | 0.8138 | **0.713** |

int8 はコサインだけ見ると無害に見えますが、**約3割の人で「一番近い人」が変わります**。
このアプリが見せたい唯一のものが壊れるので不採用にしました。fp32 は torch と完全一致
するため、**凍結マップを作り直さずにそのまま使えます**。
