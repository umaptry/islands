---
title: islands
emoji: 🏝️
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
pinned: false
---

# islands

一言の自己紹介だけで、自分の居場所が地図の上にできる。近い人＝似た話をしている人で、
タップすると二人が共有していることばが見える。人が集まった場所は島になり、
その島の名前は、そこにいる人たちの言葉から作られる。

要件定義は [`REQUIREMENTS.md`](REQUIREMENTS.md)。詳しい図解は起動後 `/how`。

---

## これは2つのものを1つにしたもの

`C:/Users/zk-ht/Downloads/islands` にある Next.js のプロトタイプは、**仕組み**を
持っていた。投稿がタグと熱量とリアクションを持ち、それが**エネルギー**に変わって
地図に**地形**を作り、影響半径が重なった投稿が Union-Find で**島**になる。
一貫していて、よくできている。ただし座標は `Math.random()` で、島の名前は
12個のキーワード表からの多数決で、データはブラウザのメモリにしかなかった。

このリポジトリは逆だった。テキスト1本から448次元 → 凍結エンコーダ → 2次元という
**本物の意味座標**があり、Supabase と Cloud Run で動いていて、「同じ文章は毎回同じ
座標」「新しい人が来ても既存の点は1pxも動かない」という保証があった。だが機能は
「1人1テキスト + いいね」だけだった。

**islands の仕組みを、この座標の上に載せたのが今の形。** 乱数だった島が意味の上に
立つので、「近い＝似た話をしている」がそのまま大陸の形になる。島の名前も、固定
ジャンル表ではなく、その陸地に実際に立っている投稿の語から作る。

---

## 仕組みの要点

### 1. どこに立つかは、書いた文章だけが決める

年齢も性別も居場所も、タグも熱量も使いません。

```
本文（30〜140字）
  ├─ どの語を使ったか  Sudachiで分かち書き → 単語TF-IDF(1-2gram) ⊕ 文字TF-IDF(2-4gram)×0.25
  │                     → TruncatedSVD(64) → L2                              …… 64次元
  └─ どんな意味か      multilingual-e5-small (ONNX Runtime) で
                        「生の文」×0.35 + 「内容語だけの文」×0.65 → L2         …… 384次元

  → hstack([意味×0.65, 語×0.35]) → L2                                        …… 448次元
  → 凍結エンコーダ f (448→512→256→128→2, GELU+LayerNorm)
  → 等方スケール（x と y に同じ倍率）→ 0-1000 の座標
```

`f` は **一度だけ** 学習して凍結してあります。教師役の UMAP を1回走らせてお手本の
配置を作り、それを再現するようニューラルネットを回帰学習させ、重みを固定しました。
以降の投影はすべて純粋な順伝播なので、

- 同じ文章は毎回 **小数点まで完全に同じ座標** になり、
- 誰が新しく投稿しても **既存の投稿は 1px も動きません**。

本文を編集すると座標は動きます。それは正しい挙動で（別のことを書いたなら別の場所に
着くべき）、編集画面にもそう書いてあります。タグ・熱量・画像を変えても動きません。

### 2. 地形は、エネルギーの足し算でできる

ここからが islands の仕組みです。

```
energy = motivation + (いいね + 手伝えるかも + 参加したい + メッセージ) × 5
radius = (30 + energy × 0.45) × (2/3)
```

各投稿が半径 `radius` の円錐（中心が最大、縁でゼロの線形減衰）を作り、それを
**加算合成** します。合計値がその地点の地形を決めます。

| 合計エネルギー | 地形 |
|---|---|
| < 0.05 | 海 |
| >= 0.05 | 浅瀬 |
| >= 30 | 砂漠 |
| >= 50 | サバンナ |
| >= 90 | 草原 |
| >= 300 | 森 |
| >= 700 | 山 |

**一つの投稿の値ではなく、その地点の合計値** で決まるのが核心です。静かな投稿が
2つ隣り合うと、単独では砂漠にしかならない場所が草原になる。人が集まるほど陸地が
広がって、離れていた島がくっついて大陸になる。

座標が意味を持っているので、この「くっつく」は偶然ではありません。**同じ話をして
いる人たちの島が、実際に地続きになります。**

### 3. 島の名前は、投稿から作る

影響半径が重なる投稿を Union-Find で推移的にまとめ、その一群を1つの島とします
（A-B と B-C が重なれば、A と C が離れていても1つの大陸）。

名前は、**その島にいる投稿の名詞を集めて「何人が使ったか × コーパスでの珍しさ」で
上位2語** を選びます。元の islands にあった12ジャンルの固定表は使いません。座標が
意味を持っている以上、固定ジャンルはただの劣化だからです。

誰も投稿していない場所には名前が無く、地図にも出ません。地図は名前のない海から
始まり、人が来るたびにその人たちの言葉で名前が増えていきます。

色だけは凍結 k-means の領域（`cluster_id`）が決めます。島はくっついたり離れたり
しますが、色が変わると地図が毎回シャッフルされて見えるためです。

（ビルド時の命名 `0.45×関連度 + 0.35×意味的近さ + 0.20×共起` は候補語を埋め込み
直すので、リクエスト中に走らせるには重すぎます。配信時は同じ `idf` と、共通語
チップと同じ名詞リストだけを使う軽い版を使っています。）

### 4. 似てる度は地図の距離ではない

地図は448次元を2次元まで潰した絵で、潰す過程でご近所関係の大半が失われます
（このビルドでは本来の近傍の34%しか残らず、`artifacts/seed_map.json` の
`meta.gates.generalization` に記録されています）。

そこで似てる度と「近い人」の並び順は、潰す前の448次元のコサインから計算します。
0〜100への変換に使う2つの基準値は `artifacts/seed_map.json` の `cosine_anchors`
（シード1,000件から測定）です。

**測る前に、シードコーパスの重心を引きます。** multilingual-e5-small は異方性が
強く、全ペア499,500組を測ると密ブロックのコサインの9割が 0.847〜0.905 という幅
0.058のコーンに収まってしまいます。そこではほとんど何も区別されないため、TF-IDF の
分散を13%しか保持していない64次元の疎ブロックが似てる度の差の7割強を決めていました。
症状としては、**同じことを違う言葉で書いた二人**（フィルムカメラ / 写真部）が、
**話題は違うが言い回しが似ている二人** より低く出ます。密ブロックからコーパス共通の
向き（`cosine_centroid`）を引くと混雑の原因が消え、20トピック×5人での実測で
AUC 0.812 → 0.890、同topic・異topicの差 0.047 → 0.175 になりました。

これは**比較の瞬間だけの読み替え**です。保存済みベクトルも地図の座標も1つも
変わりません。`cosine_anchors` にはどの空間で測ったかの印が入っていて、印と
`cosine_centroid` が揃っている時だけ中心化します。古い artifacts は旧来の計算の
まま、両者がちぐはぐな artifacts は2D距離まで退避します。

中心化した後のベクトルは `posts.vec_c` にも保存してあり、pgvector の HNSW 索引が
それを見ます。近い人の検索が O(log n) で済むのはこのためです。

各構成を同じ物差しで比べるには `python scripts/benchmark_embeddings.py` を使います。
`GEMINI_API_KEY` / `OPENAI_API_KEY` があれば、その埋め込みも次元ごとに並べて比較
します。キーは `.env.example` を `.env` にコピーして書き込みます（`.env` は
`.gitignore` 済み、環境変数のほうが優先）。開発用のスクリプトで `app.py` からは
参照されず、serving image にも `.env` にもキーにも触れません。

---

## ローカルで動かす

```bash
python -m pip install -r requirements.txt
python -m uvicorn app:app --reload --port 7860
```

Supabase が未設定のときは **ローカルモード** で起動します。

- アカウントも投稿もメモリ上にのみ保存され、再起動で消えます
- ログインのパスコードはメールではなく画面に表示されます
- `/api/local/*` という Supabase の代役が有効になります

`/api/local/*` は **本番では 404 を返します**（`SUPABASE_URL` が設定されていれば
それだけで無効になり、有効化するフラグは存在しません）。パスコードをレスポンス
ボディに入れて返せるのはこのためです。

テスト:

```bash
python -m pytest tests/ -v
```

テストも外部サービスを一切使いません。ローカルモードの上で全部走ります。

---

## 何がどこで動くか

```
ブラウザ ──(anon key + ユーザー JWT)──> Supabase PostgREST / GoTrue / Storage
   │                                     ↑ RLS が守る。全テーブルにポリシーがある
   │                                     地図の読み取り・コメント・リアクション
   │                                     ・通知・プロフィール・画像
   │
   └──(ユーザー JWT)──> Cloud Run (FastAPI)
                          埋め込みが要る書き込みだけ
                          = 投稿の作成／本文の編集
                          + 島の命名 + 似てる度
```

**なぜこう分けるか。** 読み取りとやりとりは量が多く、埋め込みを必要としません。
これを Supabase に直接行かせると、2GiB・ONNX 入りのコンテナは「投稿が作られた時
だけ」動けばよくなります。1万人でほぼ無料、その先もコンテナの台数は**投稿数に
しか比例しません**。

### ブラウザが anon キーを持つことについて

以前のこのリポジトリは「ブラウザは Supabase 資格情報を一切持たない / RLS ポリシー
0件 / 全読み書きを service_role で FastAPI 経由」という設計でした。アカウントが
本物になった時点で、これは**意図的に捨てています**。

- Supabase Auth を使う以上、ブラウザは anon キーを持ちます（GoTrue がそれを要求
  するので、避ける方法がありません）
- anon キーは公開前提の値です。守っているのは鍵ではなく
  [`supabase/schema.sql`](supabase/schema.sql) の RLS ポリシーです
- `service_role` キーは今も **Cloud Run だけ** が持ちます

サーバー専用のままにしてある2つ:

- **`posts` の INSERT。** x/y/vec は凍結エンコーダの出力です。クライアントに書かせ
  ると、誰でも好きな島の真ん中に自分を置けてしまう。それはこのアプリが唯一して
  いる主張を嘘にします。`authenticated` に INSERT ポリシーはありません
- **`posts.vec` / `vec_c` の SELECT。** RLS は列を絞れないので、列権限で外して
  あります。ベクトルはスコアを返す security definer 関数の中でしか読まれません

スキーマの末尾に、この3つを確認する SQL が書いてあります。

---

## デプロイ（Google Cloud Run + Supabase）

### 前提ツール

```bash
gcloud --version   # Google Cloud CLI
gh --version       # GitHub CLI
supabase --version # Supabase CLI
docker --version
```

### 1. Supabase

プロジェクトを作り、migration を適用します。

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

または SQL エディタで [`supabase/migrations/20260901000000_initial.sql`](supabase/migrations/20260901000000_initial.sql) を実行。
すべて if-not-exists なので再実行しても安全です。

- **Authentication → Providers → Email** を有効化。OTP（6桁コード）が使えることを確認
- Google / Apple を使うならここで設定し、環境変数 `KOTOBA_OAUTH_GOOGLE=1` /
  `KOTOBA_OAUTH_APPLE=1` を立てます（未設定ならログイン画面にボタンを出しません）
- **Project Settings → API** から `URL` / `anon` / `service_role` / `JWT Secret` を控えます
- Storage のバケット `post-images` は migration が作ります

スキーマの検証（`supabase test db` で自動実行、または SQL エディタで手動）:

```bash
supabase test db  # supabase/tests/ の pgTAP テストを実行
```

### 2. Secret Manager

秘密値はシェル履歴に残さず Secret Manager に格納します。`SUPABASE_URL` と
`SUPABASE_ANON_KEY` は公開前提の値なので通常の環境変数に置きます。

```bash
gcloud secrets create supabase-service-key --replication-policy=automatic
echo -n "eyJ..." | gcloud secrets versions add supabase-service-key --data-file=-

# HS256 プロジェクトのみ（ES256 + JWKS なら不要）:
gcloud secrets create supabase-jwt-secret --replication-policy=automatic
echo -n "..." | gcloud secrets versions add supabase-jwt-secret --data-file=-
```

Cloud Run のサービスアカウントに accessor 権限を付与:

```bash
SA="<runtime-sa>@<project>.iam.gserviceaccount.com"
gcloud secrets add-iam-policy-binding supabase-service-key \
  --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor"
```

### 3. Cloud Run（候補リビジョン → 検証 → 昇格）

```bash
REGION=asia-northeast1  # 日本向け。既存環境に合わせて変更

# イメージをビルド・プッシュ
IMAGE="$REGION-docker.pkg.dev/$PROJECT/cloud-run-source-deploy/islands:$(git rev-parse HEAD)"
docker build -t "$IMAGE" .
docker push "$IMAGE"

# 候補リビジョンを 0% traffic でデプロイ
gcloud run deploy islands \
  --image "$IMAGE" \
  --region $REGION \
  --no-traffic --tag candidate \
  --service-account "$SA" \
  --allow-unauthenticated \
  --memory 2Gi --cpu 1 \
  --max-instances 4 --concurrency 12 \
  --timeout 120 --cpu-boost \
  --set-env-vars "SUPABASE_URL=https://xxxx.supabase.co,SUPABASE_ANON_KEY=eyJ..." \
  --set-secrets "SUPABASE_SERVICE_KEY=supabase-service-key:1"

# 候補を検証（store=supabase かつ store_ok=true を確認）
curl -s https://candidate---islands-xxxx.run.app/api/health | python3 -c "
import json, sys; h=json.load(sys.stdin)
assert h['store']=='supabase' and h['store_ok'], f'FAIL: {h}'
print('OK:', h)
"

# 合格後に 100% へ昇格
gcloud run services update-traffic islands --region $REGION --to-tags candidate=100
```

`SUPABASE_JWT_SECRET` は HS256 プロジェクト用です。ES256 なら不要で、
`core/auth.py` が JWKS を自動で引きます。どちらも用意できない状態で
`SUPABASE_URL` だけ設定すると、**起動時に落ちます**。

ロールバック:

```bash
gcloud run services update-traffic islands --region $REGION --to-revisions <前のリビジョン>=100
```

### 4. 監視（Cloud Monitoring Uptime Check）

Cloud Monitoring で `/api/health` を5分おきに監視します。これが keepalive を兼ねる
ため、GitHub Actions の `keepalive.yml` のスケジュールは停止済みです。

- **Content matching**: status code 2xx だけでなく、レスポンスに `"store":"supabase"`
  と `"store_ok":true` が含まれることを確認。`/api/health` は DB 障害時も HTTP 200
  を返すため、ステータスコードだけでは検知できません
- 2地域以上で2回連続失敗した場合に通知
- 予算アラートを想定月額に合わせて設定（50%・90%・100%）

手動で keepalive を叩きたいとき:

```bash
gh workflow run keepalive
```

### なぜこの設定なのか

| 設定 | 理由 |
|---|---|
| `--region asia-northeast1` | 主利用者が日本。Tokyo も Tier 1 対象で無料枠の適用に影響なし |
| `--memory 2Gi` | 常駐 965MB + ONNX 449MB。1GiB では OOM する |
| `--max-instances 4` | 支出の上限を制限する（ただし自動停止ではない） |
| `--concurrency 12` | 1 vCPU で ONNX 推論を40本同時に捌けないため |
| 候補リビジョン + 0% traffic | 壊れたリビジョンにユーザーを送らない |
| Artifact Registry に直近2イメージを保持 | ロールバック可能にする |
| モデルをイメージに焼き込む | 2026-08-21 に HF が 429 を返して2回連続でデプロイが落ちた。焼き込めば起動時の外部依存ゼロ |
| gzip（`app.py`） | 下りの無料枠は 1GiB/月。テキスト資産は概ね 1/3 になる |

無料枠の内訳（月あたり）: 200万リクエスト / 180,000 vCPU秒 / 360,000 GiB秒 /
下り 1GiB。2GiB 構成なら 50時間ぶんのリクエスト処理時間が無料です。アイドル中は
課金されません。ただし Artifact Registry の無料枠（0.5GB/月）は請求先アカウント
全体で共有され、900MBイメージ2世代で月 $0.13 程度かかります。

### 困ったときの確認手順

```bash
curl -s https://<your-service>.run.app/api/health | python3 -m json.tool
```

`store` が `supabase`、`store_ok` が `true`、`posts` が件数。`memory` になっていたら
環境変数が外れています。ログは:

```bash
gcloud run services logs read islands --region $REGION --limit 50
```

### CI/CD

main へのプッシュで `.github/workflows/ci.yml` のテストが自動実行されます。
本番デプロイは、GCP/WIF/Cloud Run の初回セットアップ完了後に GitHub repository
variable `DEPLOY_ENABLED=true` を設定した場合だけ続行されます。あわせて
`GCP_PROJECT_ID`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`,
`CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT`, `CLOUD_RUN_REGION`, `SUPABASE_URL`,
`SUPABASE_ANON_KEY` を repository variables に設定してください。
`SUPABASE_SERVICE_KEY_VERSION` は Secret Manager の数値バージョンで、未設定時は
`1` を使います。`SUPABASE_SERVICE_KEY` 自体は GitHub に保存せず、Cloud Run が
Secret Manager の `supabase-service-key` を参照します。

有効化後の流れ:

1. Python テスト（`pytest tests/ -v`）
2. 候補リビジョンを 0% traffic でデプロイ
3. `/api/health` の content matching と静的ファイルの取得確認
4. 合格時のみ 100% traffic に昇格
5. 直近2リリースを保持し、14日以上経過した古いイメージを自動削除

PR では テストのみが走り、デプロイは行いません。

---

## どれくらい捌けるか

**構造の話（確か）と、実測（古い）を分けて書きます。**

### 構造として変わったこと

以前の `/api/map` は **毎回全員分を返していました**。人数が増えると1回の
ペイロードも増えるので、通信量は人数の2乗で効いていました（200人で1回9.5KB、
全員が15秒おきに1時間で約446MB）。

今は **視界の矩形に入っている投稿だけ** を返します（`map_posts` RPC、上限800件、
エネルギー降順）。地図をどれだけズームアウトしても1回の応答は800件で頭打ちで、
普通に見ている限りはその何分の一かです。**通信量は人数に対して線形以下**に
なりました。

同じ理由で、以前あった以下のものが不要になりました:

- 全員分のベクトルをサーバーのメモリに載せるキャッシュ（`nearest_posts` の
  HNSW 索引が置き換えました）
- 全員分の似てる度テーブル（`/api/map?viewer=` が返していたもの）
- `MAX_USERS = 200` の定員（アカウント制がその役割を担います）

レート制限も **IP単位からアカウント単位** になりました。以前の README が警告して
いた「会場のwifiは全員が同じグローバルIPになるので、既定の3回だと5分間に4人目が
弾かれる」という問題は、構造的に消えています。

### 実測（⚠️ 前の構成での数字です）

下の表は **アーキテクチャ変更前** の `/api/map`（全員分を返していた頃）を本番で
測ったものです。埋め込み・投影・命名の重さは変わっていないので**書き込み側の
目安としては今も有効**ですが、読み取り側は上に書いた理由でこれより軽くなって
いるはずです。**再測定はまだしていません。**

| 同時数 | 成功率 | 中央値 | p90 | 最大 |
|---|---|---|---|---|
| 10 | 10/10 | 0.94秒 | 0.96秒 | 0.96秒 |
| 50 | 50/50 | 1.27秒 | 1.77秒 | 2.06秒 |
| 100 | 100/100 | 1.16秒 | 1.55秒 | 1.99秒 |

100人が一斉に開いても全員2秒以内に返っていました。ただし**インスタンスが冷えて
いるときだけ**、あふれたぶんが2台目の起動を待って20〜25秒かかることがあります
（別測定で最大24.6秒）。一斉に開かせるなら開演前に一度アクセスして温めるか、
`--min-instances 1` にしてください（無料枠の消費は増えます）。

書き込みは、同時12人の投稿が本番で5.0秒・全員成功。ローカル（速いCPU）では
毎秒55〜90件処理できたので、サーバ側の処理能力は100人でも問題になりません。

**`--min-instances 1` にしたら、終わったら必ず戻してください。**

```bash
gcloud run services update islands --region us-central1 --min-instances 0
```

2GiB×86,400秒＝1日あたり172,800 GiB秒で、無料枠は月360,000 GiB秒。**1日なら
収まりますが、2日を超えると課金が始まります。**

### さらに伸ばすなら

ここまでで詰まったときに効く順:

1. **静的ファイルを CDN へ。** `web/` はビルド不要の素のファイルなので、
   Cloudflare Pages なり Cloud Storage + CDN なりにそのまま置けます。
   コンテナは API だけになります
2. **読みと書きで Cloud Run を2つに割る。** 地図タイルと島の命名だけを返す側は
   ONNX を積む必要がないので 512MiB で足ります。重いイメージを読みトラフィックで
   スケールさせないのが、いちばん大きなコスト削減になります
3. **`posts.vec` を `halfvec(448)` に。** 保存とHNSW索引が半分になります。
   精度への影響は `scripts/benchmark_embeddings.py` で測ってから
4. **低ズームの地形を `energy_cells` に寄せる。** 表と RPC は既にあります
   （視界に800件を超える投稿が入ったときだけ使われます）

---

### カード登録なしで試したいとき

ローカルの uvicorn に Cloudflare Quick Tunnel を被せると、アカウント不要・完全無料で
HTTPS の公開 URL が出ます。PC を起動している間だけ生きる URL なので、面談や短時間の
デモ向けです。

```bash
cloudflared tunnel --url http://localhost:7860
```

Supabase を設定していなければローカルモードのままなので、その場でアカウントを
作って試せます（パスコードは画面に出ます）。

---

## 構成

```
app.py                  FastAPI。torch を一切読み込まない
                        /api/posts        投稿の作成・編集・削除（要JWT）
                        /api/islands      島の検出と命名
                        /api/neighbors    近い人（448次元コサイン）
                        /api/pair         2投稿の似てる度と共通のことば
                        /api/account/me   プロフィール
                        /api/config       ブラウザが描画に使う定数一式
                        /api/health       keepalive が叩く
                        /api/local/*      Supabase の代役（本番では404）
core/
  config.py             全パラメータの単一の置き場
  auth.py               Supabase JWT の検証（HS256 / JWKS）
  energy.py             islands の計算式と Union-Find（サーバー側）
  features.py           テキスト → 448次元
  embedder.py           multilingual-e5-small を ONNX Runtime で動かす層
  encoder.py            凍結エンコーダの numpy 実装 + .npz の読み書き
  clustering.py         島の選定と特徴語ペアの命名
  geometry.py           等方スケール / 完全重複の分離
  similarity.py         448次元コサイン→似てる度% / 共通キーワード
  store.py              Supabase(PostgREST) とインメモリの2実装
  stopwords.py          自己紹介ドメイン向けストップワード
supabase/schema.sql     テーブル・生成列・トリガ・索引・RLS・RPC・Storage
web/
  index.html            全画面のマークアップ
  style.css
  js/
    config.js           /api/config の取得と、そこから引く計算
    net.js              API と、Supabase / ローカルの2つのデータ経路
    session.js          サインイン（GoTrue を素の fetch で叩く）
    state.js            画面をまたぐ状態
    router.js           ハッシュルーティングとボトムナビ
    ui.js               トースト・シート・DOM ヘルパ
    image.js            画像の縮小・再エンコード（投稿画像とアイコン共通）
    avatars.js
    map/
      index.js          カメラ・ジェスチャ・地図と orbit の描画
      terrain.js        エネルギー場 → バイオームのラスタ
      landmass.js       Union-Find（クライアント側）
      decor.js          海図の波・小舟・鳥・波打ち際
    components/         postcard.js / chat.js
    screens/            auth / compose / map / notifications / profile
scripts/
  seed_corpus.jsonl     シード1,000件
  validate_corpus.py    ビルド前の検査
  build_seed_map.py     凍結マップ構築（1回だけ実行）/ --relabel / --verify
  build_similarity_calibration.py  似てる度の目盛りを校正（座標は動かない）
  rotate_map.py         既存マップを90度回転（座標の距離は不変）
  train_parametric.py   torch を使う唯一のモジュール（学習専用）
artifacts/              seed_map.json / vectorizers.pkl / encoder.npz
tests/
  test_energy.py        islands の計算式、Union-Find、サーバーとJSの定数一致
  test_islands.py       島の命名（固定ジャンル表を使っていないこと）
  test_social.py        リアクション・コメント・通知・権限
  test_pipeline.py      凍結マップの保証、似てる度の較正、同時実行
  test_supabase_store.py  偽 PostgREST 相手の店舗層とリトライ方針
```

### 配信スタックに torch が入らない理由

埋め込みは `core/embedder.py` が **ONNX Runtime** で、凍結エンコーダは
`core/encoder.py` が **numpy** で動かします。結果、配信イメージに torch も
umap-learn も入りません。

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

int8 はコサインだけ見ると無害に見えますが、**約3割の人で「一番近い人」が変わり
ます**。このアプリが見せたい唯一のものが壊れるので不採用にしました。fp32 は torch と
完全一致するため、**凍結マップを作り直さずにそのまま使えます**。

### フロントエンドにビルドが無い理由

`web/js/` は素の ES モジュールです。バンドラもトランスパイラもありません。
そして **supabase-js を CDN から読み込んでいません** — GoTrue も PostgREST も
Storage も素の REST なので、`net.js` と `session.js` に薄いクライアントを自分で
書いてあります（合わせて500行ほど）。

理由は 2026-08-21 の教訓です。起動時に Hugging Face からモデルを取る設計だった頃、
HF が 429 を返してデプロイが2回連続で落ちました。`<script src="https://cdn...">`
は、それと同じ形のリスクを**実行時に**持ち込みます。

---

## 地図を作り直す（通常は不要）

> **警告**: `build_seed_map.py` を実行するとエンコーダが再学習され、**全員の座標が
> 変わります**。すでに投稿した人は自分の居場所を見失います。`artifacts/` は公開後は
> 不変として扱ってください。

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
python scripts/build_similarity_calibration.py --dry-run  # 数値だけ見る
python scripts/build_similarity_calibration.py            # 似てる度の目盛りを校正（3分）
```

どれも保存済みの座標をそのまま使うため、**既存の点は1pxも動きません**
（`rotate_map.py` は書き込む前に全ペア距離が不変であることを検証し、
`build_similarity_calibration.py` は `seed` / `scale_bounds` / `islands` /
`meta` / `distance_quantiles` / `idf` が1文字も変わらないことを確認してから
書き込みます）。

島名を直したいときは、まず `core/stopwords.py` の `LABEL_ONLY_STOP_WORDS` /
`DISPLAY_STOP_WORDS` を調整してください。この2つは**ベクトルに一切影響しません**。
`GENERAL_STOP_WORDS` のほうは特徴量に効くので、触ると再ビルドが必要になります。

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

## 既知の限界

- **本文の編集は投稿を動かします。** 仕様どおりですが、コメントが付いた投稿を
  書き換えると、会話が別の島に移動します
- **画像は人手で確認していません。** 自動判定は入れていないので、通報
  （`reports` テーブル）と作者自身の削除が唯一の手当てです
- **メッセージは5秒ポーリング**で、WebSocket ではありません。1万人規模なら十分
  ですが、リアルタイム感が要るなら Supabase Realtime に寄せる余地があります
- **低ズームの粗い地形（`energy_cells`）は近似です。** セルの合計エネルギーを
  そのセルの中心に置いた1投稿として描いています。視界に800件を超える投稿が
  入ったときだけ使われます
- **読み取り側の性能を再測定していません。** 上の「どれくらい捌けるか」を参照
- **`scripts/build_demo_page.py` は islands 化で未移植です。** 前提にしていた
  1ファイルの `web/app.js` と旧APIが両方とも無くなっているため、実行すると
  理由を表示して止まります。似てる度エンジンの比較だけなら
  `scripts/benchmark_embeddings.py` が使えます（こちらは無傷）
