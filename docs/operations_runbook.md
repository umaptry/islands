# islands 運用手順

更新日: 2026-09-09。実装・検証結果と本番反映状況を分けて記録する。

## 確定した対象と管理者

| 対象 | 継続利用する環境 |
|---|---|
| 運用管理 | umaptry@gmail.com / GitHub umaptry |
| GCP | gen-lang-client-0999045451 |
| Cloud Run | islands / asia-northeast1 |
| 公開URL | https://islands-vfjsyo6oyq-an.a.run.app（最新成功デプロイで確認） |
| Supabase | soznrzkhvktzxlslpphm |
| GitHub | umaptry/islands |
| Geminiキー | 対象projectでユーザーが発行した有料キー。Secret Manager `GEMINI_API_KEY:2`。旧暫定キーは移行後の保持確認まで削除しない |
| runtime SA | cloud-run-runtime@gen-lang-client-0999045451.iam.gserviceaccount.com |
| deploy SA | github-deploy@gen-lang-client-0999045451.iam.gserviceaccount.com |
| WIF | projects/657692547640/locations/global/workloadIdentityPools/github-pool/providers/github-provider |

gen-lang-client-0496696977への移転・新サービス作成は行わない。他アプリ、共有プロジェクト、Googleアカウント自体は整理対象外。

## 初期確認の記録（最新状況は下記の本番切替記録を参照）

- GitHub CLIをumaptryで認証し、ADMINを確認。`DEPLOY_ENABLED=false` に変更済み。既存runは終了済みだった。
- 最新成功デプロイ（run 34224490347）はislands-vfjsyo6oyqでstore_ok=true・投稿6件を確認。旧KOTOBA_MAP_URLのislands-6roec5boqaはstore_ok=falseだったが、現行本番の結果と混同しない。
- GCPはumaptry@gmail.comがownerであることをブラウザとCLIの両方で確認し、CLI認証と既定projectを対象へ統一済み。
- ローカル `.env` のGeminiキーで合成テキスト1件の疎通成功。384次元、L2ノルム1.0。Supabase接続情報はローカルに未設定。
- 同梱manifestは `onnx / kotoba-map-v1`。旧資料の「providerがgeminiで不整合」という記述は現状に当てはまらない。manifestの手編集・checkoutによる巻き戻しは不要。
- Python回帰131件と追加復旧2件、Node回帰5件、DB29件、Playwright8件（375/390/768/1440px）成功。追加変更後の結果はリリース記録で更新する。
- Gemini成果物ビルド、品質比較、本番migration、復旧リハーサル、本番切替、24時間監視は完了記録が揃うまで未完了扱い。

### 有料キーへの更新と候補検証（2026-09-09）

- ユーザーが対象projectで発行した有料キーを `GEMINI_API_KEY:2` に保存し、GitHubの `GEMINI_API_KEY_VERSION=2` を設定。キー値は記録しない。
- `output/gemini-v1` に `islands-gemini-20260909-v1` の4成果物を生成。既存 `artifacts/` は維持。
- 本番とホールドアウトの学習を同じ3000 epochへ統一（PR #3、全CI成功）。1500 epochでの汎化比率0.633も履歴として残し、同条件再評価では0.6872（基準0.65）。ドリフト0、決定性一致、NumPy/Torch最大差1.10e-06。固定ホールドアウトを再利用した再評価であり、独立の追加評価は次の100件比較による。
- 公開 `scripts/probe_topics.jsonl` の100件でE5比較に合格。AUC 0.811629→0.896695、top1 0.29→0.52、特徴空間P@k 0.255→0.3525、地図P@k 0.1175→0.2025。
- 比較レポート: `output/quality/islands-gemini-20260909-v1.json`。配布ZIP SHA-256: `877bf9d123a29d5480a59c434e0d014dab656238fcfe62d2082870121f8419c4`。
- 非公開固定版: `gs://islands-map-artifacts-657692547640/releases/islands-gemini-20260909-v1.zip#1788907608171460`。
- 切替前バックアップ: `output/backups/20260909-before-gemini-switch`。投稿4、accounts/Auth各3、comments 1、Storage画像4、energy_cells 6。
- 投稿4件のGemini再計算を `output/gemini-posts-20260909.json`、E5計算値を `output/e5-before-gemini-20260909.json` に保存。本番適用結果は次節。

### 本番切替と通常CIの確認（2026-09-09 JST）

- 候補CI [34287609059](https://github.com/umaptry/islands/actions/runs/34287609059) 成功。保守開始、投稿4件の最終差分確認、移行RPC適用、候補のmaintenance検証、`islands-00014-jik` へのtraffic切替、保守解除、公開URLのready検証を実施した。
- 通常リリースCI [34288478999](https://github.com/umaptry/islands/actions/runs/34288478999) も成功（2026-09-09 08:04 JST完了）。Python・frontend・browser・DB・image検証と候補検証・昇格が成功。コードはPR #3反映済み `de29887`。
- 最新確認時のtrafficは `islands-00016-bum` に100%。image digestは `sha256:b4a8401ad8a00ce2f4d29b38748f813ffd4613ddf8fd22b968154e02f089d8bd`。公開healthはgemini / gemini-embedding-2 / 384次元、DB・成果物とも `islands-gemini-20260909-v1`、ready/store_ok/artifact_compatible=true、maintenance=false、投稿4件。
- 通常CI変数をGemini・上記固定成果物URI/hash・Secret版2へ設定し、`DEPLOY_ENABLED=true` に復帰。変数変更後に明示的なreleaseを起動し、継続デプロイまで確認した。
- 本番で一時テストユーザーのパスワード認証、アカウント作成、画像upload/read、投稿、本文編集、反応、コメント、投稿削除を確認。Geminiを使った投稿1.750秒・編集1.031秒。一時画像・ユーザーは削除済み。記録は `output/production-smoke-result.json`。メールOTP配送・本人によるログイン確認は未実施。ブラウザでは版変更後の再読込と地図表示を確認した。
- 切替後バックアップは `output/backups/20260909-after-gemini-switch`。切替前とのローカル比較でaccounts 3・comments 1の全フィールド一致、投稿4件は座標・cluster_id・vec・vec_c・updated_atのみ変更、Storage画像4件はSHA-256一致。reactionsは前後0件。energy_cellsは6→10、embedding_cacheは0→7。
- Artifact Registryの圧縮imageSizeBytesはE5 `islands-00012-zow` が562,499,829、Gemini候補 `islands-00014-jik` が239,801,373（約57.4%削減）。Docker展開後容量とは区別する。
- E5復旧revision `islands-00012-zow`、digest `sha256:6e4b7fc946eeb70c6f0ac417bbc6ea0c7d803de68e6ef7c15a41eabd3ee9f96e` と計算値・成果物・バックアップは30日以上保持する。削除はまだ行っていない。
- 未完了: 公開後24時間の観測、隔離環境で実CLIの通常rollbackと `rollback --reproject` をStorageまで含めて通す総合リハーサル、Supabase組織管理権限の集約確認、不要リソースの参照監査と整理。既存の復旧回帰テスト・DBテスト成功を総合リハーサル完了とは扱わない。

## 作業環境と認証

### localhost参照画面の反映完了（2026-09-09）

- 正本 `C:/Users/zk-ht/Downloads/islands/islands` のwebpack開発サーバー（localhost:3001）と4画面幅で比較し、登録入口・名前/所属/メール入力・登録後ガイド3画面・初回投稿を反映した。登録前introを初期導線から外し、登録後に参照元の説明を表示する。
- [PR #5](https://github.com/umaptry/islands/pull/5)、commit `677f494`、[本番CI 34295713919](https://github.com/umaptry/islands/actions/runs/34295713919) 全テスト・デプロイ成功。稼働revision `islands-00020-xod`。ローカルとCIのブラウザ回帰16件成功。
- 公開URLで登録項目、ガイド順序、起動し直した際の途中再開、実認証でのプロフィール保存、実Gemini初回投稿→地図表示、完了後にガイドを繰り返さないことを検証した。メールOTPの実配送は今回の検証に含めず、ローカルOTPと本番の認証済み一時ユーザーで確認。
- 一時ユーザーとその投稿は削除済み。最終healthはready=true、artifact_compatible=true、posts=0、Gemini版は `islands-gemini-20260909-v1` のまま。記録画像は `output/production-reference-*.png`。対象外の参照フォルダや共有環境は変更していない。

### 初回ガイド修正とユーザーデータ初期化（2026-09-09）

- ユーザーの明示依頼により、対象SupabaseのAuthユーザー4件と全投稿・関連データ・Storage画像4件を削除した。削除直後のaccounts/posts/reactions/comments/notifications/reports/Auth/Storageはすべて0件。energy_cellsとembedding_cacheも消去し、モデル・成果物・map_runtimeは保持した。
- 非公開バックアップ: `output/backups/20260909-before-user-reset`。削除記録: `output/user-reset-result.json`。この操作で過去の「既存データ保持」の状態は意図的に更新された。バックアップは復旧用に残る。
- 原因は未認証の初期ルートがwelcomeを指してintroを通らないことと、登録済みアカウントをguidanceからmapへ戻すguard。PR #4で初期intro→welcome、プロフィール保存→guidance→初回投稿へ修正し、削除済みユーザーの残存セッションも再確認してintroへ戻すようにした。
- 4画面幅で導入スライド完了とプロフィール保存後のguidance・再読込・投稿画面遷移を回帰検証。ローカル12件成功。本番反映CI: [34292695151](https://github.com/umaptry/islands/actions/runs/34292695151) 全検証・デプロイ成功。リリース `a8d20b1`、revision `islands-00018-qor`、公開healthはready=true・posts=0。
- 公開URLの実ブラウザでintro→welcome、実認証ユーザーによるsetup保存→guidance→再読込→compose、削除済みユーザーの残存セッション→introを確認。一時テストユーザーは削除済み。画面記録 `output/production-intro.png`。

Python 3.12を使用。このPCでは `C:/Users/zk-ht/AppData/Local/Programs/Python/Python312/python.exe` が利用可能。
ローカルE5は `requirements-onnx.txt`、テストは `requirements-test.txt`、学習は `requirements-build.txt` を使用する。`requirements.txt` はGemini配信用。

```powershell
gh auth status
gh repo view umaptry/islands --json viewerPermission
gcloud auth list
gcloud run services describe islands --project gen-lang-client-0999045451 --region asia-northeast1 --account umaptry@gmail.com
```

GCPはプロジェクトの表示名ではなく実IDを明示する。umaptryに権限がなければ既存管理者が付与する。別プロジェクトを作って代替しない。Supabaseもumaptry管理の既存projectへログインする。
WIFは `umaptry/islands` のmainだけに制限済み。deploy SAとruntime SAは分離済みで、runtimeのSecret accessorは `supabase-service-key` と `GEMINI_API_KEY` の個別Secretに限定済み。

## 変更前の保全とDB準備

1. `DEPLOY_ENABLED=false` と実行中workflowの有無を確認する。
2. 現行traffic/revision/image digest、SA、設定、Secret版番号、E5成果物4点のhashを非公開のリリース記録に保存する。
3. `scripts/backup_supabase.py` でアプリ用テーブル、Authユーザー情報、Storage実体の論理バックアップを `output/` に保存する。Supabaseの基盤バックアップ範囲もdashboardで確認する。migrate_mapのJSONは計算値スナップショットであり完全バックアップではない。
4. 隔離DBで全migrationと `supabase test db` を通す。ローカルにはDockerが必要。GitHubのdatabase-testでも実行する。
5. 本番のmigration履歴を確認し、`20260908000000_model_runtime.sql` と `20260908010000_runtime_write_lock.sql` の未適用分のみ適用する。手動SQL適用歴があればCLI履歴と整合させる。
6. DB接続を復旧し、E5/v1のまま `MAP_RUNTIME_CHECK=1` のリリースを先行させる。healthのstore_ok/ready/compatible=trueと版一致を確認する。

## Gemini成果物と品質判定

キーは既存のプロセス環境または非公開設定から読み、コマンド引数や履歴へ値を書かない。
API上限はAI Studioの当該projectで確認する。資料の無料枠数値を固定仕様と見なさない。
`GEMINI_REQUESTS_PER_MINUTE=60` と `GEMINI_ITEMS_PER_MINUTE=90` はプロセス単位の既定値。
複数コンテナ合計の制限やTPM/RPD保証ではない。429時は停止・キャッシュ再利用し、無断で課金枠を変更しない。

```powershell
$env:EMBEDDING_PROVIDER = 'gemini'
$env:MAP_BUILD_VERSION = 'islands-gemini-20260908-v1'
python scripts/build_seed_map.py --artifacts output/gemini-v1
python scripts/build_seed_map.py --artifacts output/gemini-v1 --verify
python scripts/compare_map_release.py --baseline artifacts --candidate output/gemini-v1 --output output/quality-gemini-v1.json
python scripts/artifact_release.py pack --source output/gemini-v1 --output output/gemini-v1.zip --provider gemini --version islands-gemini-20260908-v1 --quality-report output/quality-gemini-v1.json
```

ビルドは `--fast` を使わず4ゲートすべてを通す。比較は同じラベル付きprobeで、本番と同じ384次元・前処理・学習済みvectorizersを使う。AUC、top1、特徴空間と地図それぞれの近傍精度がE5以上でなければ終了コード1。比較未達の成果物を公開しない。
packは合格レポートとmanifest hashの一致を要求し、4成果物だけをZIPへ格納する。投稿本文・再計算JSONは配布しない。
ZIPをislands専用の非公開GCSバケットへ新しいオブジェクト名で保存する。public access prevention、versioningを有効にし、CIには当該バケットのobjectViewerだけを付与する。既存名を上書きせず `--if-generation-match=0` を使用する。
リリース選択は `gs://bucket/object.zip#generation` とZIP全体のSHA-256で固定する。

## CIの操作

`.github/workflows/ci.yml` は次の3操作を持つ。通常pushは `DEPLOY_ENABLED=true` の時だけリリースする。

| workflow_dispatch action | 挙動 |
|---|---|
| test | テストのみ |
| audit | 既存CIのWIFでCloud Run・IAM・API・Secret版メタデータを読み取り。秘密値は取得しない |
| migration-candidate | DEPLOY_ENABLED=falseでも明示起動可。候補を0%で作成・確認し、昇格しない |
| release | DEPLOY_ENABLED=trueが必要。readyな候補のみ、検証したrevisionへ100%昇格 |

共通variablesは既存WIF/deploy SA/runtime SA、SUPABASE_URL/ANON_KEYと `SUPABASE_SERVICE_KEY_VERSION`（固定の整数）。
通常pushの選択には `EMBEDDING_PROVIDER`, `MAP_ARTIFACT_VERSION`, `MAP_ARTIFACT_URI`, `MAP_ARTIFACT_SHA256` を使う。
Gemini時は `GEMINI_API_KEY_VERSION`（Secret Managerの固定の整数）も設定する。参照先は既存の `GEMINI_API_KEY`。GitHub SecretのGEMINI_API_KEYを本番コンテナへ直渡ししない。
手動実行ではprovider/artifact_version/artifact_uri/artifact_sha256を明示する。
既存サービスが存在しなければ停止し、新規公開サービスは自動作成しない。環境変数とSecretはupdateで変更し、既存OAuth等の設定を保持する。
Docker target=geminiにはONNXモデルや推論・学習依存を含めず、target=onnxは復旧用モデルを同梱する。イメージのbytesとdigestはActions summaryへ記録する。
自動cleanupは削除処理を行わない。DEPLOY_ENABLEDをtrueへ変えるだけではデプロイは開始されない。

## 投稿再計算とメンテナンス切替

Supabase service key等を準備プロセスへ設定する。ファイルは非公開のoutput配下に保存する。

```powershell
$env:MAP_ARTIFACTS_DIR = (Resolve-Path output/gemini-v1).Path
python scripts/migrate_map.py prepare --backup output/e5-before.json --output output/gemini-posts.json
python scripts/migrate_map.py apply --input output/gemini-posts.json
```

prepareは投稿・runtimeを変更しないが、サーバー専用embedding_cacheへ書き込む。途中でAPI制限に当たった場合、同じbackup/outputで `prepare --resume` を使う。版・ID・本文・更新時刻が変わっていれば再利用せず、新しい保存先で再準備する。

1. migration-candidateを明示起動してGeminiコンテナを先に作る。新モデル/成果物/公開configを検査し、DBとの不一致はこの段階だけ許容する。
2. アプリ内で位置変更を案内する。別途指示のない外部メール等は送らない。
3. `python scripts/migrate_map.py maintenance on`。API、直接DB、Storage書き込み停止を確認する。
4. applyのdry-runでID/本文/更新時刻/件数/現行版を再確認。不一致なら適用せずE5側を再開して再準備する。
5. `python scripts/migrate_map.py apply --input output/gemini-posts.json --execute`。RPCは全計算値とDB版を一括更新し、途中不一致なら全体を取り消す。
6. `verify_release.py --phase maintenance` に候補URL/provider/version/supabase-urlを渡す。DB版一致・compatible=true・maintenance=true・ready=falseを要求する。
7. 候補の既存投稿・地形・読み取りを確認後、記録済みrevisionへ `gcloud run services update-traffic islands --project gen-lang-client-0999045451 --region asia-northeast1 --to-revisions REVISION=100`。
8. `maintenance off` の後、同じverifyを `--phase ready` で実行する。正式URLでも確認する。
9. 投稿・本文編集・画像・本人による認証・反応・コメントを確認し、Gemini使用量と遅延を測定する。
10. 通常push用のGemini設定を固定し、CI再リリースを確認してから自動運用へ戻す。

## 島の AI 命名の出し方と戻し方（2026-10-12）

島の名前を Gemini で付ける機能は、**環境変数 `ISLAND_NAMING_ENABLED` が `1` のときだけ**動く。既定はオフ（未設定なら従来の上位語の名前のまま）。CI の変数・秘密は変えず、次の順で人が操作する。

1. **SQL を流す**：`supabase/migrations/20261012000000_ai_island_names_no_connection.sql` を Supabase の SQL エディタで流す（何度流しても壊れない。古いコードも壊れない）。
2. **新しいコードを出す**：main へ入れて CI を通す。`/api/health` の `ready` は、`islands_state` に `name_source` 列が読めないと `false` になる（`island_names_ready`・`not_ready_reasons` に理由が出る）ので、手順1を忘れると `verify_release.py --phase ready` が昇格を止める。
3. **動作確認**：`/api/health` が `ready=true`、`island_names_ready=true`。`/api/islands` が今までどおり返ること。この時点ではまだ AI 命名はオフ。
4. **鍵の確認**：オンにする前に、Cloud Run のコンテナに `GEMINI_API_KEY` が入っているか確認する（`gcloud run services describe islands --project <ID> --region asia-northeast1` の環境変数・Secret を見る）。onnx 構成のコンテナには入っていないことがあり、その場合は Secret を手動で足す必要がある。足すのは本番の設定変更なので、**2人の合意が要る**。鍵がないと `load_namer()` が何もせず、AI の名前は付かない（エラーにもならない）。
5. **オンにする**：Cloud Run の環境変数に `ISLAND_NAMING_ENABLED=1` を足して新しい revision を出す。**同時に `web/how.html` の島名の説明（216行目付近）を更新する**（AI が投稿全体のジャンルを1語で付ける＝書き手3人以上・投稿5件以上の島。それ以外の島や、鍵がない・失敗したときは、投稿の名詞から上位2語）。AI で名前を付けるのは書き手3人以上かつ投稿5件以上の島だけ。同じ島は24時間あけないと呼び直さない（通信エラーは「試した」印を付けないので、次の追跡でまた呼ぶ）。1回の追跡で呼ぶのは最大4回。既定のモデルは `gemini-3.5-flash-lite`（`ISLAND_NAMING_MODEL` で変えられる）。
6. **オンにした直後の確認**：ログに `island naming: … -> …`（INFO。投稿本文・個人名は出ない）が出ること。**`island naming: HTTP 404` / `HTTP 400` のログが出ていないこと**（モデル名の誤り・提供終了・鍵の誤りのサインで、出ていたら `ISLAND_NAMING_MODEL` と鍵を見直す。通信エラーの間は島に印が付かないので、直せばすぐ付き直す）。

**止めたいとき**：`ISLAND_NAMING_ENABLED` を外す（または `0`）。すでに付いた AI の名前は `islands_state` に残り、そのまま表示され続ける（新しく付けないだけ）。

**古い版のコードへ戻すとき**：古いコードは `name_source` を知らないので、AI の名前が付いた島を従来の名前に戻し、**AI の名前が付いた島の書き手に「名前が変わった」通知**（人と島ごとに1日1件まで）を出してしまう。これを防ぐには、旧イメージから `ISLANDS_AUTO_TRACK=0` を付けた**新しい revision を作って**そこへ traffic を向ける。**旧 revision への単純な `update-traffic` だけでは `ISLANDS_AUTO_TRACK=0` が付かず、通知が出る**（環境変数は revision ごとの設定のため）。

```powershell
# 1) 旧イメージ（digest）から、追跡を止めた新しい revision を作る（traffic はまだ流さない）
gcloud run deploy islands --project <ID> --region asia-northeast1 --image <旧digest> --update-env-vars ISLANDS_AUTO_TRACK=0 --no-traffic --tag rollback
# 2) その revision に traffic を向ける（revision 名は 1) の出力で確認）
gcloud run services update-traffic islands --project <ID> --region asia-northeast1 --to-revisions <その revision>=100
```

`ISLANDS_AUTO_TRACK=0` の間は島の追跡が止まり、通知は出ない（名前の表示は旧コードの計算になる）。SQL の列は残したままでよい（古いコードは読まない・書かない）。

**旧コードの追跡が走ってしまった場合だけ**（`ISLANDS_AUTO_TRACK=0` で止めていたなら流さず、そのまま新しい revision へ進めてよい）、新しいコードへ進める前に、保存されている AI の名前の印を消す補修 SQL を流す。**流すと全部の AI 島の名前がいったん従来名に戻り、新コードで付け直されるときに「名前が変わった」通知が出る**ので、本当に必要なときだけにする。

```sql
update public.islands_state set name_source = 'terms', name_basis = null, name_tried_at = null where name_source = 'ai';
```

そのうえで新しいコードの revision を出し、落ち着いてから `ISLANDS_AUTO_TRACK` を外す。

**不適切な名前が付いたとき**
- 名前を人が決めて固定する（`manual` の島は、コードが名前を変えず、AI も呼ばない）。島の id は `select id, name, name_source from public.islands_state where active order by created_at;` で調べる。

```sql
-- 固定する
update public.islands_state set name = '手芸', name_source = 'manual' where id = '島のid';
-- 固定をやめる（次の追跡から従来の名前に戻り、条件を満たせば AI が付け直す）
update public.islands_state set name_source = 'terms', name_basis = null, name_tried_at = null where id = '島のid';
```

- 言葉そのものを禁止する：環境変数 `ISLAND_NAME_BLOCKLIST` にカンマ区切りで足す（例 `競馬,パチンコ`）。組み込みの禁止語は `core/island_namer.py` の `BLOCKED`。新しい revision を出すと効く。**禁止語は今後の答えに効く**。すでに付いた AI の名前が禁止語を含む場合は、次の読み込みから従来の名前に戻る（コードが再検査する）。付いた名前を別の名前にしたいときは、上の `manual` の SQL で直せる。

## Google・LINE でのログインの出し方（2026-10-13）

コードは入っている。ボタンは Cloud Run の環境変数 `KOTOBA_OAUTH_GOOGLE` / `KOTOBA_OAUTH_LINE` が `1` のときだけ出る（未設定なら今までどおりメールのパスコードだけ）。Google・LINE・Supabase・Cloud Run の設定変更なので、**2人の合意が要る**。順番は「外の設定（Google・LINE・Supabase）→ 動作確認 → 環境変数」。環境変数を先に立てると、押しても失敗するボタンが出る。

### Google

1. Google Cloud Console の「Google Auth Platform」（OAuth 同意画面）：対象は「外部」。アプリ名とサポート用のメールを入れる。スコープは `openid`・メール・プロフィールだけにする（この範囲なら Google の審査は要らない）。公開ステータスを「本番環境」にする（「テスト」のままだと、登録したテストユーザーしか入れない）。
2. 「クライアント」を種類「ウェブ アプリケーション」で作る。承認済みのリダイレクト URI に `https://<project-ref>.supabase.co/auth/v1/callback` を入れる。
3. Supabase → Authentication → Sign In / Providers → Google を有効にし、クライアント ID とクライアント シークレットを貼る。
4. Supabase → Authentication → URL Configuration の Redirect URLs に、本番の URL（末尾 `/`）があることを確かめる。ないと、ログイン後に Site URL へ戻される。

### LINE

LINE は Supabase に最初から入っている接続先ではないので、「Custom Providers」（2026-04 から。無料プランでも3つまで）で足す。

1. LINE Developers コンソールで、プロバイダーを作り、その下に「LINE ログイン」チャネルを作る（アプリタイプは「ウェブアプリ」）。チャネルは後から別のプロバイダーへ移せない。
2. Supabase → Authentication → Sign In / Providers → 一番下の Custom Providers → New Provider。
   - 識別子は **`custom:line`**（コードがこの名前で呼ぶ。`web/js/session.js` の `SUPABASE_PROVIDERS`）
   - 種類は OIDC、Issuer は `https://access.line.me`。Client ID はチャネル ID、Client Secret はチャネルシークレット
   - メールなしでも登録できる設定（email optional）を有効にする。LINE は申請しないとメールを渡さない
   - 画面に出る Callback URL を控える
   - OIDC で ID トークンの検証に失敗するとき（LINE のウェブログインの ID トークンは HS256 署名のことがある）は、種類を OAuth2 にして手で入れる：authorize `https://access.line.me/oauth2/v2.1/authorize`、token `https://api.line.me/oauth2/v2.1/token`、userinfo `https://api.line.me/oauth2/v2.1/userinfo`、スコープ `openid profile`
3. LINE のチャネル →「LINE ログイン設定」→ コールバック URL に、手順2で控えた Callback URL を入れる。
4. メールも受け取りたいときだけ：チャネル基本設定 → OpenID Connect →「メールアドレス取得権限」を申請する（利用目的が分かる画面の写しが要る）。islands はメールがなくてもアカウントを作れるので必須ではない。
5. 「開発中」のチャネルは、チャネルの管理者とテスターしかログインできない。確認が済んでから「公開」にする（**公開は元に戻せない**）。

### 出す

1. **ボタンを出す前の確認**：ブラウザで `https://<project-ref>.supabase.co/auth/v1/authorize?provider=google&redirect_to=<本番のURL>/`（LINE は `provider=custom:line`）を開く。ログインのあと本番の画面へ戻り、名前とアイコンの設定（`#/setup`）が出れば通っている。
2. Cloud Run の環境変数を足して新しい revision を出す。CI の deploy は `--update-env-vars` で決まった変数だけを書き換えるので、ここで足した変数は次の deploy でも残る。

   ```powershell
   gcloud run services update islands --project <ID> --region asia-northeast1 --update-env-vars KOTOBA_OAUTH_GOOGLE=1,KOTOBA_OAUTH_LINE=1
   ```

3. 入口の画面に「Googleで登録」「LINEで登録」、ログイン画面に「Google で続ける」「LINE で続ける」が出る。メールのボタンは「メールアドレスで登録」に変わる。

**止めたいとき**：`--remove-env-vars KOTOBA_OAUTH_LINE` などで外す。ボタンが消えるだけで、その方法で作ったアカウントは残る。ただしメールを渡していない LINE の人は、メールのパスコードでは入れなくなるので、止める前に人数を確かめる。

## 地図の作り直し（2026-10-15：地図の見方 v3・お手本 10,182 件）

**何が変わったか**

- 投稿の位置を決めるエンコーダが読むベクトルを、保存した448次元そのものから「地図の見方」（`core.similarity.map_view`）に変えた。意味の部分からお手本の平均を引き（偏りの補正）、語（TF-IDF）の重みを 0.35 → 0.20 に下げたもの。似てる度（`vec_c`）も同じ見方で測る。保存するベクトル（`vec`）の作り方と埋め込みのキャッシュは変わらない
- お手本（`scripts/seed_corpus.jsonl`）を 1,000 件 → 10,182 件にした。追加の 9,182 件は約90の分野ごとに書いた架空の短い投稿（`area` 付き）
- 新しい見方の成果物は manifest の `schema_version` が 2。**古いコードは 2 を読めず起動時に止まる**（黙って間違った場所に置かない）。新しいコードは 1（今の本番の成果物）も 2 も読める
- 効果（評価用の例文100件・20話題×5件、Gemini。近くの4件に同じ系統の話題がいるか）：「1件もいない」36% → 10%、「1番近い投稿が同じ系統」38% → 82%。リリース比較の地図上の P@k 0.20 → 0.46（`output/quality-gemini-20261015-v2.json`）
- 品質ゲートの近所の数を「お手本の1.5%（最低15）」にした（1,000件のときの15件＝1.5%と同じ意味）。k=15 の値も `meta.gates.generalization` に残る。10,182 件の Gemini 版では k=15 で生徒役が上限比 0.37（UMAP の transform は 0.74）で、細かい近所の再現は生徒役の弱点として残っている（学習方法の改善候補）
- 島の名前の候補は「島の文書の4%以上、ただし最大20件」に出る語（1万件で島1つが1,000件を超え、4%では名前が付かなかった）

**ビルド環境（Windows の注意）**

- パスが長いと torch・numba が入らない／動かない。短い場所に仮想環境を作る（例 `%TEMP%\mb`）。`NUMBA_CACHE_DIR` も短い場所に
- `requirements-build.txt` はそのままでは入らない（`google-genai==1.64.0` が `httpx>=0.28.1` を要求し、`requirements.txt` の `httpx==0.27.2` とぶつかる）。地図づくりに google-genai は要らないので次で入れる（版は本番と同じ）。`PYTHONUTF8=1` も付ける（requirements の日本語コメントで止まるため）

  ```powershell
  $env:PYTHONUTF8 = '1'
  python -m pip install -r requirements-onnx.txt torch==2.7.1 umap-learn==0.5.5
  ```

- Gemini の埋め込みは約2万文書（お手本の本文と内容語の2通り）。既定の速度（`GEMINI_ITEMS_PER_MINUTE=90`）だと約4時間かかるので、有料枠の範囲で上げる（2026-10-15 は 1500/分で制限に当たらなかった）。`.cache/embeddings.sqlite3`（キーは `embedding_spec` と本文）にあるものは呼ばない
- 所要（8スレッドのPC、Gemini と E5 を並行）：1回 1〜1.5時間。半分以上はホールドアウトのための学習のやり直し

**作り方**

```powershell
$env:EMBEDDING_PROVIDER = 'gemini'; $env:MAP_BUILD_VERSION = 'islands-gemini-20261015-v2'
python scripts/build_seed_map.py --artifacts output/gemini-v2
$env:EMBEDDING_PROVIDER = 'onnx'; $env:MAP_BUILD_VERSION = 'kotoba-map-e5-v2'
python scripts/build_seed_map.py --artifacts output/e5-v2   # 手元と CI 用。artifacts/ の4ファイルを置き換える
```

**版の名前は毎回新しくする。** 本番の切り替えは DB の `map_runtime.active_version` と成果物の版の一致で判断するので、同じ名前を使い回すと新旧の位置が混ざっても気付けない。

**本番への出し方（相手の方との合意が要る。CI 変数・GCS・本番 DB を触るため）**

1. コードを先に main へ出す。新しいコードは今の本番の成果物（schema 1）のまま、今までどおり動く
2. `compare_map_release.py`（基準は `artifacts/` の E5 v2）→ `artifact_release.py pack` → GCS へ新しいオブジェクト名で保存 → CI 変数（`MAP_ARTIFACT_VERSION` / `MAP_ARTIFACT_URI` / `MAP_ARTIFACT_SHA256`）を新しい版へ
3. 「投稿再計算とメンテナンス切替」の手順どおり（prepare → maintenance on → apply → verify → traffic → maintenance off）。全投稿の `vec` / `vec_c` / `x` / `y` / `cluster_id` が新しい地図で計算し直される。語の辞書（`vectorizers.pkl`）が新しくなるので `vec` も変わるが、Gemini の埋め込みはキャッシュが効くので API はほぼ呼ばない
4. 全投稿の位置が動く。アプリ内で事前に知らせる（既存の手順の2）

**戻し方**：既存の「復旧とデータ保持」と同じ（旧 revision＝旧コードと旧成果物に traffic を戻し、`migrate_map.py rollback`）。新しいコードのまま CI 変数を旧 ZIP に戻すこともできる（schema 1 を読める）。

**残っている課題**

- プロフィールの似てる度の目盛り（`PROFILE_COSINE_ANCHORS`）は仮の値のまま。お手本の平均が変わるので、実際のプロフィールが集まったら測り直す
- **島の強弱**：投稿が増えると、話題の違う島どうしが「影響範囲（普通の熱量で半径35）」の重なりで鎖のようにつながり、1つの大陸になる。評価用の短い投稿478件（24話題）を新しい地図に置くと 475 件が1つの島になった（古い地図でも 476 件）。並べ方（UMAP の設定11通り・分野ラベル付き）では隙間ができず、島がつながる距離と地図の広さの比率を見直す必要がある（距離0.6倍で島43・系統のまとまり59%、0.5倍で島69・71%）。島の規則は元の islands の設計なので、2人で決める

## 復旧とデータ保持

切替前に隔離DBで両経路をリハーサルし、ID/本文/画像実体/反応/コメント/アカウントの保持を確認する。

```powershell
python scripts/migrate_map.py maintenance on
python scripts/migrate_map.py rollback --backup output/e5-before.json --output output/rollback-e5.json
python scripts/migrate_map.py apply --input output/rollback-e5.json
python scripts/migrate_map.py apply --input output/rollback-e5.json --execute
```

公開後に投稿集合や本文が変わっていれば通常rollbackは停止する。旧E5 provider/artifactsを指定して `rollback --reproject` で現在の投稿を再計算する。古い全DBバックアップを戻して新規投稿や反応を消さない。
DBを戻した後に保存したE5 revisionへtrafficを戻す。DB/成果物/モデル版が揃ってからmaintenanceを解除する。コンテナだけ戻さない。

## 監視・整理・記録

公開後24時間、ready/store_ok/artifact_compatibleとprovider/model/version、503/429、埋め込み遅延、メモリ、Supabase応答、認証を観測する。Monitoringと通知先は実リソースを確認・設定して記録し、READMEの記述だけで稼働済みとしない。
E5の復旧用image/成果物/設定/計算値は移行後30日以上保持する。
整理候補は今回不要になったislands専用のservice/image/Secret/WIF等だけ。現行参照・暫定キー・復旧用途・共有用途のあるものは保持する。リソース一覧と根拠が揃ってから削除し、削除後に本番を再確認する。
リリース記録には確認日時、git SHA、image digest/サイズ、revision/traffic、Secret版、成果物hash、migration履歴、件数、品質・復旧・画面テスト結果、監視開始/終了時刻を残す。秘密値と実投稿本文を公開記録へ含めない。

## 引き継ぎ資料

1. [環境構成マップ](https://claude.ai/code/artifact/3902e970-3c3c-40a9-9f34-52572cffd2d3)
2. [Gemini移行手順](https://claude.ai/code/artifact/a62dfb40-1160-4db1-8fa1-ec1e82a42c47)
3. この運用手順

外部2資料は参考の過去記録。0496696977への移転、他アプリの削除、APIキーの平文入力、CI variable変更だけでデプロイする手順は採用しない。最新の対象・順序・実施状況は本書とリリース記録を優先する。

### 2026-09-08 追加確認

- 現行URL `https://islands-vfjsyo6oyq-an.a.run.app/api/health` の直接確認に成功。store_ok=true、ready=true、onnx/kotoba-map-v1、maintenance=false、投稿4件（時点値）。旧URLの結果を訂正。
- KOTOBA_MAP_URLを現行URLに修正済み。
- PR #1のCIでDB29件を含む全4系統のテストが成功。続く変更は再検証中。
- Geminiは公開seed corpusの980ベクトルをキャッシュ済み。残りは `EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier`、quotaValue=1000で停止。日次枠回復または課金枠変更まで再試行しない。課金設定の変更は未実施。
- 日次制限は専用エラーで即時停止し、繰り返しAPIへ送らない。取得済みキャッシュを保持する。

### 2026-09-09 追加確認

- `umaptry@gmail.com` のGCP ownerを確認し、gcloud CLI認証を更新済み。WIF条件を `umaptry/islands` かつ `refs/heads/main` に限定した。
- Cloud Run runtime SAのproject全体Secret accessorを外し、`supabase-service-key:1` と `GEMINI_API_KEY:1` の参照だけを個別付与した。Geminiの有効Secret版とローカル暫定キーは、値を表示せず同一性を確認した。
- 非公開成果物バケット `gs://islands-map-artifacts-657692547640` をasia-northeast1に作成。uniform access、public access prevention、object versioningを有効化し、deploy SAにはobjectViewerだけを付与した。
- deploy SAには監査用のIAM policy、Service Usage、Secretメタデータの読取ロールを付与した。秘密値の参照権限は付与していない。
- 切替前論理バックアップを `output/backups/20260909-pre-gemini` に保存。accounts 3、posts 4、comments 1、Auth users 3、Storage objects 4（その他の対象テーブル0）をmanifestとSHA-256付きで記録した。
- 本番へ `20260908000000_model_runtime.sql` と `20260908010000_runtime_write_lock.sql` を適用し、手動適用済みのinitialを含む3版を `supabase_migrations.schema_migrations` と同期した。確認時点はactive_version=`kotoba-map-v1`、maintenance=false、posts 4、accounts 3、embedding_cache 0。
- GitHub Actions run 34246448487でPython、frontend、browser、DB、offline E5 imageと0%候補を検証。候補 `islands-00012-zow` を公開URLでもready=trueと確認後、同revisionへtrafficを100%固定した。
