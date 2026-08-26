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

URL を知っていれば誰でも参加できます（アカウント不要・最大200投稿）。

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

**領域**（クラスタ）は公開座標そのものに対する k-means（k は 6〜10 から自動選定）で、
これは `artifacts/` の一部として凍結されています。どの領域に入るかは
`assign_cluster` が凍結レイアウトに対して決めるので、あとから動きません。

**似てる度は地図の距離ではありません。** 地図は448次元を2次元まで潰した絵で、
潰す過程でご近所関係の大半が失われます（このビルドでは本来の近傍の34%しか残らず、
`artifacts/seed_map.json` の `meta.gates.generalization` に記録されています）。
そこで似てる度と「近い人」の並び順は、潰す前の448次元ベクトルのコサインから
計算しています。0〜100への変換に使う2つの基準値は
`artifacts/seed_map.json` の `cosine_anchors`（シード1,000件から測定）です。

**測る前に、シードコーパスの重心を引きます。** multilingual-e5-small は異方性が強く、
全ペア499,500組を測ると密ブロックのコサインの9割が 0.847〜0.905 という幅0.058の
コーンに収まってしまいます。そこではほとんど何も区別されないため、TF-IDF の分散を
13%しか保持していない64次元の疎ブロックが似てる度の差の7割強を決めていました。
症状としては、**同じことを違う言葉で書いた二人**（フィルムカメラ / 写真部）が、
**話題は違うが言い回しが似ている二人**より低く出ます。密ブロックからコーパス共通の
向き（`cosine_centroid`）を引くと混雑の原因が消え、20トピック×5人での実測で
AUC 0.812 → 0.890、同topic・異topicの差 0.047 → 0.175 になりました。

これは**比較の瞬間だけの読み替え**です。保存済みベクトルも地図の座標も1つも変わりません
（`normalize(hstack([dense×0.65, sparse×0.35]))` の前後を再正規化すれば元のブロックが
誤差 1.6e-08 で戻るため）。`cosine_anchors` にはどの空間で測ったかの印が入っていて、
印と `cosine_centroid` が揃っている時だけ中心化します。古い artifacts は旧来の計算のまま、
両者がちぐはぐな artifacts は2D距離まで退避します。

各構成を同じ物差しで比べるには `python scripts/benchmark_embeddings.py` を使います。
`GEMINI_API_KEY` / `OPENAI_API_KEY` があれば、その埋め込みも次元ごとに並べて比較します
（`gemini-embedding-2` はタスク接頭辞も軸に含めます）。キーは `.env.example` を
`.env` にコピーして書き込みます（`.env` は `.gitignore` 済み、環境変数のほうが優先）。
開発用のスクリプトで `app.py` からは参照されず、serving image にも `.env` にも
キーにも触れません。追加パッケージは `requirements-build.txt` 側です。

**島の名前は投稿から作ります。** 領域ごとに、そこにいる投稿の名詞を集めて
「何人が使ったか × コーパスでの珍しさ」で上位2語を選びます。誰も投稿していない
領域には名前が無く、地図にも出ません。地図は名前のない海から始まり、人が来る
たびにその人たちの言葉で名前が増えていきます。シードコーパス由来の固定ジャンルは
表示しません。

（ビルド時の命名 `0.45×関連度 + 0.35×意味的近さ + 0.20×共起` は候補語を埋め込み
直すので、リクエスト中に走らせるには重すぎます。配信時は同じ `idf` と、共通語
チップと同じ名詞リストだけを使う軽い版を使っています。）

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

```bash
python scripts/build_similarity_calibration.py --dry-run  # 数値だけ見る
python scripts/build_similarity_calibration.py            # 似てる度の目盛りを校正（3分）
```

どれも保存済みの座標をそのまま使うため、**既存の点は1pxも動きません**
（`rotate_map.py` は書き込む前に全ペア距離が不変であることを検証し、
`build_similarity_calibration.py` は `seed` / `scale_bounds` / `islands` /
`meta` / `distance_quantiles` / `idf` が1文字も変わらないことを確認してから
書き込みます）。

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
| `--memory 2Gi` | 常駐 965MB + ONNX 449MB。1GiB では OOM する |
| `--max-instances 1` | 支出の上限を物理的に固定する。副次的に、`app.py` のプロセス内レートリミッタ（3 join / 300秒 / IP）が分散で骨抜きにならない |
| モデルをイメージに焼き込む | 起動時に Hugging Face から取る設計だったが、2026-08-21 に **HF が 429 を返して2回連続でデプロイが落ちた**（起動プローブ4分でタイムアウト）。焼き込めば起動時の外部依存がゼロになる。代償は Artifact Registry の無料枠 0.5GB/月の超過で、**1イメージだけ残す運用なら月 $0.05 程度**。詳細は `Dockerfile` のコメント |
| gzip（`app.py`） | 下りの無料枠は北米 1GiB/月。実測で `app.js` 28.4KB→9.2KB、`/api/map` 20.1KB→8.8KB。初回訪問あたり約70KB→28KBになり、無料枠で捌ける来訪者が約2.5倍になる |

無料枠の内訳（月あたり）: 200万リクエスト / 180,000 vCPU秒 / 360,000 GiB秒 / 下り 1GiB。
2GiB 構成なら 360,000 ÷ 2 = **50時間ぶんのリクエスト処理時間**が無料です。アイドル中は
課金対象時間が発生しません。念のため請求先アカウントに**予算アラートを ¥1 で設定**し、
Artifact Registry には常に1イメージだけ残す運用にしてください。

### デモ当日の運用

公開URL: https://kotoba-map-315170697037.us-central1.run.app

**現在の設定（デモ用に絞ってある）**

| 設定 | 値 | 理由 |
|---|---|---|
| `--min-instances` | **1** | コールドスタートを誰にも見せないため。**これだけは一時設定** — 下記参照（モデル焼き込み後の起動は数秒） |
| `--max-instances` | 4 | 人が一斉に来たときの詰まり対策。支出の上限も兼ねる |
| `--concurrency` | 12 | 1 vCPU で ONNX 推論を40本同時に捌けないため。12×4=48並列まで |
| `KOTOBA_RATE_LIMIT_MAX` | 50 / 300秒 | 会場のwifiは全員が同じグローバルIPになる。既定の3回だと5分間に4人目が弾かれる。**100人規模なら200に上げること** — 下記「何人まで捌けるか」参照 |
| `MAX_USERS` | 200 | `core/config.py`。ひとりで複数投稿できるので、これは人数ではなく投稿数の上限。超えると409で断る |

### 何人まで捌けるか（実測）

**先に結論。100人規模なら、閲覧は余裕・登録はレート上限だけが引っかかります。**

| 項目 | 上限 | 根拠 |
|---|---|---|
| 同時に地図を開く人数 | **100人で問題なし** | 本番実測。下表参照 |
| 登録できる総数 | **200件**（`MAX_USERS`） | 超えると409。人数ではなく**投稿数**の上限 |
| 同一IPからの登録 | **50件 / 5分** | ⚠️ **100人規模ではここが詰まる**。下記参照 |
| 下り通信量 | 100人1時間で約132MB | 無料枠は月1GiB |

**同時アクセスの実測**（本番、`/api/map`、既存10人時点）

| 同時数 | 成功率 | 中央値 | p90 | 最大 |
|---|---|---|---|---|
| 10 | 10/10 | 0.94秒 | 0.96秒 | 0.96秒 |
| 50 | 50/50 | 1.27秒 | 1.77秒 | 2.06秒 |
| 100 | 100/100 | 1.16秒 | 1.55秒 | 1.99秒 |
| 100（2回目） | 100/100 | 1.04秒 | 1.41秒 | 1.75秒 |

100人が一斉に開いても全員2秒以内に返ります。ただし**インスタンスが冷えている
ときだけ**、あふれたぶんが2台目の起動を待って20〜25秒かかることがあります
（別測定で最大24.6秒を観測）。`kotoba-map-warm` が1台目を温め続けているので
1台目に収まる範囲（同時12）なら発生しません。一斉に開かせるなら開演前に一度
アクセスして温めるか、`--min-instances 2` にしてください（無料枠の消費は倍）。

**登録（`/api/join`）**

同時12人の登録は本番で5.0秒、全員成功。ローカル（速いCPU）では毎秒55〜90件
処理できたので、サーバ側の処理能力は100人でも問題になりません。

⚠️ **効いてくるのはレート制限です。** `check_rate_limit` は**同一IPあたり
50件 / 300秒**で、51件目を429で断ります（実測確認済み）。会場のwifiは全員が
同じグローバルIPになるので、**100人が5分以内に登録しようとすると後半が弾かれます。**

さらに、このカウンタは**プロセス内**にあります。`--max-instances 4` なので
実効的な上限は「どのインスタンスに振られたか」次第で50〜200件のあいだで揺れ、
**誰が弾かれるかが運になります**。100人規模でやるなら事前に上げてください。

```bash
gcloud run services update kotoba-map --region us-central1   --update-env-vars KOTOBA_RATE_LIMIT_MAX=200
```

200まで上げても危険はありません。**本当の歯止めは `MAX_USERS=200` のほう**で、
レート制限は「地図が埋まる速さ」を変えるだけだからです。

**通信量**（実測、gzip後）

| 地図の人数 | `/api/map` 1回 | 全員が15秒おきに1時間 |
|---|---|---|
| 10人 | 1.5KB | 約 1.4MB |
| 100人 | 5.6KB | 約 132MB |
| 200人 | 9.5KB | 約 446MB |

無料枠は月1GiB。**100人で2時間のイベントなら約260MB**で収まりますが、同じ月に
何度もやると超えます。人数が増えるほど1回のペイロードも増えるので、通信量は
人数の2乗で効いてくることに注意してください。


**デプロイのたびに古いイメージを消してください。**

```bash
gcloud artifacts docker images list us-central1-docker.pkg.dev/kotoba-map-demo/cloud-run-source-deploy --include-tags
gcloud artifacts docker images delete "us-central1-docker.pkg.dev/kotoba-map-demo/cloud-run-source-deploy/kotoba-map@sha256:<latestが付いていない方>" --quiet
```

Artifact Registry の無料枠は 0.5GB/月、イメージ1つで約900MB です（モデルを
焼き込んでいるため。理由は `Dockerfile` のコメント）。**1つでも無料枠を約0.4GB
超えるので月 $0.05 前後かかり、2つ残すとその倍になります。** 以前に
デプロイを重ねて 1,969MB まで膨らみ、月 $0.15 ほどの課金が始まる手前でした。
消し忘れると素直に増えるので、この手順はデプロイのたびに実行してください。
`latest` が付いているものが稼働中なので、それ以外を消します。容量の表示は
集計が遅れるので、消した直後は数字が変わりません。

**デモが終わったら必ずこれを実行してください。**

```bash
gcloud run services update kotoba-map --region us-central1 --min-instances 0
```

`min-instances 1` はインスタンスを24時間起こしたままにします。2GiB×86,400秒＝
1日あたり172,800 GiB秒で、無料枠は月360,000 GiB秒。**1日なら収まりますが、
2日を超えると課金が始まります。** 戻したあとは Cloud Scheduler の
`kotoba-map-warm`（3分おきに `/api/health` を叩く。稼働確認済み）が代わりに
温め続けるので、コールドスタートはほぼ起きません。

**困ったときの確認手順**

```bash
curl -s https://kotoba-map-315170697037.us-central1.run.app/api/health
```

`store` が `supabase`、`store_ok` が `true`、`users` が人数。`memory` に
なっていたら Supabase の環境変数が外れています。ログは:

```bash
gcloud run services logs read kotoba-map --region us-central1 --limit 50
```

Supabase 無料プロジェクトは7日アクセスがないと一時停止しますが、上の warm
ジョブが `/api/health` 経由で件数を引くので、放っておいても止まりません。

---

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
  similarity.py         448次元コサイン→似てる度% / 共通キーワード
  store.py              Supabase（PostgREST）とインメモリの2実装
  stopwords.py          自己紹介ドメイン向けストップワード
scripts/
  seed_corpus.jsonl     シード1,000件
  validate_corpus.py    ビルド前の検査
  build_seed_map.py     凍結マップ構築（1回だけ実行）/ --relabel / --verify
  build_similarity_calibration.py  似てる度の目盛りを校正（座標は動かない・再実行可）
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
