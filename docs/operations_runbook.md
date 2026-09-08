# islands 運用手順

更新日: 2026-09-08。実装・検証結果と本番反映状況を分けて記録する。

## 確定した対象と管理者

| 対象 | 継続利用する環境 |
|---|---|
| 運用管理 | umaptry@gmail.com / GitHub umaptry |
| GCP | gen-lang-client-0999045451 |
| Cloud Run | islands / asia-northeast1 |
| 公開URL | https://islands-vfjsyo6oyq-an.a.run.app（最新成功デプロイで確認） |
| Supabase | soznrzkhvktzxlslpphm |
| GitHub | umaptry/islands |
| 暫定Geminiキー | otofuya22@gmail.comの既存キー。継続利用し、発行元を削除しない |
| runtime SA | cloud-run-runtime@gen-lang-client-0999045451.iam.gserviceaccount.com |
| deploy SA | github-deploy@gen-lang-client-0999045451.iam.gserviceaccount.com |
| WIF | projects/657692547640/locations/global/workloadIdentityPools/github-pool/providers/github-provider |

gen-lang-client-0496696977への移転・新サービス作成は行わない。他アプリ、共有プロジェクト、Googleアカウント自体は整理対象外。

## 今回確認した結果

- GitHub CLIをumaptryで認証し、ADMINを確認。`DEPLOY_ENABLED=false` に変更済み。既存runは終了済みだった。
- 最新成功デプロイ（run 34224490347）はislands-vfjsyo6oyqでstore_ok=true・投稿6件を確認。旧KOTOBA_MAP_URLのislands-6roec5boqaはstore_ok=falseだったが、現行本番の結果と混同しない。
- GCP CLIはumaptryでCloud Run取得不可。otofuya22でも対象projectのIAM取得不可。GCP管理権限の集約は未実施。
- ローカル `.env` のGeminiキーで合成テキスト1件の疎通成功。384次元、L2ノルム1.0。Supabase接続情報はローカルに未設定。
- 同梱manifestは `onnx / kotoba-map-v1`。旧資料の「providerがgeminiで不整合」という記述は現状に当てはまらない。manifestの手編集・checkoutによる巻き戻しは不要。
- Python回帰131件と追加復旧2件、Node回帰5件、DB29件、Playwright8件（375/390/768/1440px）成功。追加変更後の結果はリリース記録で更新する。
- Gemini成果物ビルド、品質比較、本番migration、復旧リハーサル、本番切替、24時間監視は完了記録が揃うまで未完了扱い。

## 作業環境と認証

Python 3.12を使用。このPCでは `C:/Users/zk-ht/AppData/Local/Programs/Python/Python312/python.exe` が利用可能。
ローカルE5は `requirements-onnx.txt`、テストは `requirements-test.txt`、学習は `requirements-build.txt` を使用する。`requirements.txt` はGemini配信用。

```powershell
gh auth status
gh repo view umaptry/islands --json viewerPermission
gcloud auth list
gcloud run services describe islands --project gen-lang-client-0999045451 --region asia-northeast1 --account umaptry@gmail.com
```

GCPはプロジェクトの表示名ではなく実IDを明示する。umaptryに権限がなければ既存管理者が付与する。別プロジェクトを作って代替しない。Supabaseもumaptry管理の既存projectへログインする。
WIFは対象repositoryとmainに制限し、deploy SAとruntime SAを分離する。runtimeには必要なSecretのみaccessorを付与する。

## 変更前の保全とDB準備

1. `DEPLOY_ENABLED=false` と実行中workflowの有無を確認する。
2. 現行traffic/revision/image digest、SA、設定、Secret版番号、E5成果物4点のhashを非公開のリリース記録に保存する。
3. DB全体（Authを含む復元範囲を確認）とStorage実体をバックアップする。migrate_mapのJSONは計算値スナップショットであり完全バックアップではない。
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
Gemini時は `GEMINI_API_KEY_VERSION`（Secret Managerの固定の整数）も設定する。GitHub SecretのGEMINI_API_KEYを本番コンテナへ直渡ししない。
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
