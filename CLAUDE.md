# islands の共同作業の決まり（2人で作る）

このリポジトリは2人で作っている。どちらの Claude Code もこの決まりに従う。

## 話している人の意見を聞く
- いま話している人の意見がいちばん優先。決まった設計（REQUIREMENTS.md・docs/）と違う希望が出たら、黙って合わせず、違いを示して2〜3案を出し、選んでもらってから直す。
- 相手の手元にある別のフォルダ（自分のコード・デザイン・資料）を参考にするときは、読むだけにして変えない。

## 本番の環境は変えない
- GitHub umaptry/islands・Cloud Run islands（GCP gen-lang-client-0999045451）・Supabase soznrzkhvktzxlslpphm の3つを2人で使う。新しいプロジェクトは作らない。
- CI の変数・秘密の値・IAM・Supabase の設定は、2人が合意したときだけ変える。

## git の進め方
- main は本番。main へ入ると CI が通ったあと自動で本番へ出る（約8分）。
- 作業は自分の枝で：`git switch main && git pull --ff-only` → `git switch -c <名前>/<内容>`。
- 出すときは枝を push して PR を作る（PR で CI のテストが走る）。緑になったら main へ取り込む。force push は main にしない。
- 同じファイルを2人で同時に直さない。始める前に PR と枝の一覧で、相手が触っている所を確かめる。
- 本番 DB の変更は supabase/migrations に足し、supabase/tests に pgTAP を書く。本番へは Supabase の SQL エディタで流す（コードより先に、古いコードでも壊れない形で）。

## 公開リポジトリ
- 鍵（.env・API キー・サービスキー）、本物の利用者のデータ（output/・demo/）、企画の非公開資料はコミットしない。
- docs や PR に個人の連絡先・非公開の企画の中身を書かない。

## 動かし方とテスト
- 手元：`python -m pip install -r requirements-onnx.txt` → `python -m uvicorn app:app --reload --port 7860`（Supabase なしのローカルモード。データはメモリだけ）。
- テスト：`python -m pytest tests/ -q` と `node --test tests/frontend/*.test.mjs`。
- 画面を変えたら、スマホ幅（390）と PC 幅（1366）で撮って確かめてから出す。

## コードの地図（探す前にここを見る）
ファイルを足す・分ける・役目を変えたら、この節も直す。README.md の「構成」は古い部分がある。

### データの通り道
- ブラウザ → Supabase に直接：地図の読み取り・コメント・反応・通知・DM・コミュニティ。守りは RLS と RPC（supabase/migrations）。
- ブラウザ → Cloud Run（app.py の FastAPI）：埋め込みが要るもの＝投稿の作成・編集、島の検出と命名、似てる度、つながりの線、プッシュの送信。
- 手元モード（Supabase なし）では、Supabase に行く分が app.py の `/api/local/*` と core/store.py の `MemoryStore` に置き換わる。本番では `/api/local/*` は 404。

### 1つの機能が通るファイル（データを足す・変えるとき）
画面 web/js/screens/*.js → web/js/net.js の `data.○○`。net.js には `supabaseBackend` と `localBackend` があり、同じ名前で両方に書く。その先は次の2つ。片方だけ直すと、手元か本番のどちらかで動かない。
- 本番：supabase/migrations/*.sql（テーブル・RLS・RPC）＋ supabase/tests/*.sql（pgTAP）。サーバーが読むなら core/store.py の `SupabaseStore` も。
- 手元：app.py の「local mode」節の `/api/local/*` ＋ core/store.py の `MemoryStore`。

### app.py の中の節（`# ----` の見出しで区切られている。上から順に）
- startup：成果物の読み込みと起動
- request models：受け取るデータの形
- helpers：ログイン中の人、回数制限、機能のオンオフ（`*_on()`）
- members only：コミュニティのメンバーだけに見せる絞り込み（`viewer_communities`・`scoped`）。島の検出と命名もこの節の後半（`live_islands`・`name_by_genre`・`name_islands_with_ai`・`track_islands`）
- people layer：つながりの線・似ている人・新しい住人の通知（`connection_lines`・`similar_people`・`notify_resident`）
- Web Push：プッシュ通知の送信（`dispatch_pushes`）
- API：`/api/config`・`/api/islands`・`/api/connections`・`/api/posts`（作成・プレビュー・編集・共有・削除）・`/api/matches` など
- local mode：`/api/local/*`（Supabase の代役）。末尾に「join approval」の見出しで承認制の道（承認の切り替え・申し込み状況・取り消し・一覧・決める）
- account：`/api/account/me`（両方のモード）
- static：`/`・`/how`・`/privacy`・`/terms`・`/sw.js`

### core/（サーバーの部品）
- 地図の計算：features.py（文章→448次元）、embedder.py（E5 を ONNX で動かす）、encoder.py（→座標）、placement.py、geometry.py、energy.py・terrain.py（地形）
- 島：clustering.py（島に分ける）、island_namer.py（Gemini で名前）、island_tracking.py（作り直しても同じ島として追う）、growth.py（島の育ち方）
- 人のつながり：connections.py（線）、affinity.py（人どうしの似かた）、matching.py（新しい投稿が誰につながるか）、introductions.py（紹介の一文）、similarity.py（距離→似てる度%）
- 投稿：post_extras.py（お題・募集）、prompts.py（今週のお題）、quiet.py（反応のない投稿をそっと見せる）、stopwords.py
- 通知：notifications.py（`allows`。`ALWAYS_ON_NOTIFICATION_TYPES` の2種類は設定に関係なく常にオン）、webpush.py
- 名前を出してよい人：visibility.py（`visible_ids`・`display_name_for`・`mask_person`。accounts を閉じたあとのブラウザと同じ見え方。サーバーが名前を返す所は通す：push の文・近い投稿のカード・島の住人の顔・人のカード・おかえり・手元の通知一覧。地図の中の線は今のメンバーに絞ってあるので通さない）
- 土台：config.py（設定値はすべてここ）、auth.py（ログインの確認）、store.py（`MemoryStore` と `SupabaseStore`）

### web/（画面。ビルドなしの素の ES モジュール）
- 入口：index.html（全画面のマークアップ）、style.css、js/app.js（起動）、js/router.js（画面の切り替えと下のナビ）、js/state.js、js/config.js
- 画面 js/screens/：map.js（地図画面と投稿シート）、map-extras.js（島カードなど地図の周り）、compose.js（投稿）、auth.js（ようこそ・ログイン・初回プロフィール・ガイダンス）、profile.js、notifications.js、dm.js、invite.js、community-edit.js、meet.js（留守のあいだの変化）、waiting.js（承認待ち・お断り・外された、#/waiting）、fullname.js（フルネームの確認、#/fullname。判断は fullname-rules.js）
- 部品 js/components/：postcard.js、chat.js（投稿の下のメッセージ）、talk-button.js（もっと話してみたい）、image-viewer.js、heatobject.js
- 地図の描画 js/map/：index.js（カメラ・操作・描画の中心）、terrain.js・terrain-worker.js（地面）、coast.js・land.js・landmass.js（陸と海）、buildings.js（家と町）、pins.js、lines.js（人の線）、kin.js（点線）、decor.js・surf.js・vehicles.js・sparkles.js（飾り）、palette.js（色）
- 通信：net.js（`api` が Cloud Run、`data` が Supabase か手元）、session.js（ログイン）、realtime.js（通知をすぐ受け取る）、push.js・push-ask.js・sw.js（プッシュ）
- 機能ごとのまとめ役：talk.js（もっと話してみたい・DM）、communities.js、share.js（ほかのコミュニティにも出す）、catchup.js（新しい住人）
- `*-rules.js`：画面に触らない判断だけを切り出したもの。tests/frontend/ でテストする。判断を足すならまずここ。

### テスト（直した場所 → 走らせるもの）
- core/・app.py → tests/test_*.py（pytest）
- web/js/ の判断 → tests/frontend/*.test.mjs（node --test）
- 画面の操作 → tests/browser/*.spec.mjs（Playwright。CI で走る）
- supabase/migrations → supabase/tests/*.sql（pgTAP。CI で走る）

### 文書
- REQUIREMENTS.md（決まった設計）、docs/implementation_status.md、docs/operations_runbook.md（本番の出し方と戻し方）、docs/api_reference.md
