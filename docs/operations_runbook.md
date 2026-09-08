# islands 運用手順

更新日: 2026-09-08。以下は今回の追加コードに対応する手順案。
新マイグレーション・Gemini移行・復旧の本番リハーサルは未実施。
未検証の手順を「復旧確認済み」として扱わない。

## リリースを分ける

1. E5/v1のまま操作・外観とモデル整合性保護をリリースする。
2. 別領域でGeminiの成果物と既存投稿の計算値を準備する。
3. 品質比較と復旧リハーサルを通してから、メンテナンスでDB・artifacts・コンテナを同時に切り替える。

現在のCIは1のE5リリース用であり、Gemini切替後の通常デプロイにはそのまま使わない。
Gemini切替を始める前に `DEPLOY_ENABLED=false` で自動リリース・cleanupを止める。
Gemini用のprovider・Secret・artifact版を明示したCIへの変更と再検証が終わるまで再開しない。

## 事前検証

ローカルで利用可能なPythonを使い、作業ディレクトリをリポジトリルートにする。

```powershell
python -m pytest tests/ -v --tb=short
node --test tests/frontend/*.test.mjs
npm install --no-save @playwright/test@1.55.0
npx playwright install chromium
npx playwright test
npx --yes supabase@2.39.2 start
npx --yes supabase@2.39.2 test db
```

Supabaseローカル検証にはDockerが必要。CLI設定の根拠は
[Supabase公式](https://supabase.com/docs/guides/local-development/cli/config)、
ブラウザCIの根拠は [Playwright公式](https://playwright.dev/docs/ci-intro)。
ブラウザ結果は `output/`。参照側は指定フォルダで `npx next dev --webpack` を起動し、
既存devプロセスとのロック競合を確認する。ユーザーが起動したプロセスを無断終了しない。

Node回帰5件とJavaScript構文チェックはこの作業中に成功。
Pythonの113件成功は変更前の基準結果。追加後のPython、ブラウザ、DBは未実行。
新CIジョブを追加したことと、CIが成功したことを区別する。

## DBマイグレーションとSecret

`supabase/migrations/20260908000000_model_runtime.sql` をE5保護リリースより先に適用する。
ローカルで全migrationsを再生してRLS/Storageテストを通し、対象projectの適用履歴を確認する。
SQL Editorでの手適用とCLI適用を混在させる場合、履歴の一致も確認する。

追加するのはruntime行、サーバー専用embedding cache、直接書き込みの保守制御、
service専用 `apply_map_version` RPC。デフォルトはE5/v1かつmaintenance=falseなので
旧アプリを停止せずにDBを準備できる。適用を省くと新CI候補はreadyチェックで失敗する。

本番SecretはGoogle Secret Managerで版を固定し、Cloud Run runtimeサービスアカウントに
必要なSecretへのaccessorを付与する。キーの値をコマンド引数・ログ・Gitに書かない。

| 設定 | E5保護リリース | Geminiリリース |
|---|---|---|
| EMBEDDING_PROVIDER | `onnx` | `gemini` |
| MAP_RUNTIME_CHECK | `1` | `1`（本番Geminiは必須） |
| MAP_ARTIFACTS_DIR | 同梱`artifacts` | Geminiのimmutableディレクトリ |
| SUPABASE_SERVICE_KEY | Secret参照 | 同じDBのSecret参照 |
| GEMINI_API_KEY | 不要 | `gemini-api-key:<固定版>` などのSecret参照 |
| SUPABASE_URL / ANON_KEY | 既存project | 同じproject |

`gcloud run deploy` の `--set-secrets` はSupabaseとGeminiの両方を含め、既存Secretを
意図せず消さない。環境変数も同様に全必要値を含める。Secret名と現在のIAMは未確認。

## E5候補を確認して昇格

CIはテスト→image push→候補リビジョン0%→health/config/static確認→100%へ昇格する。
候補の `/api/health` で次を一致させる。

- `store=supabase`, `store_ok=true`, `ready=true`
- `embedding.provider=onnx`, `embedding.model=intfloat/multilingual-e5-small`
- `artifact_version=active_map_version=kotoba-map-v1`, `artifact_compatible=true`
- `maintenance=false`、公開configのmap_versionも一致

併せて参照との差分スクリーンショット、実際の画像保存、OTP・反応・コメントの往復を確認する。
現在のCI静的チェックだけでは画面の品質承認を代替できない。

## Geminiのビルドと既存投稿の準備

現在の `artifacts/` を直接上書きしない。旧3ファイルとmanifest、旧DB計算値、
旧コンテナのdigestを同じリリース記録に保存する。旧コンテナはcleanup対象から外す。
旧DBの完全バックアップ、Storageのバックアップも別途取得し、復元可否を確認する。
移行スクリプトが保存するのは計算値の復旧用スナップショットで、完全DBバックアップではない。

以下の `output/` はGitとDocker送信対象外。ファイルには投稿本文とベクトルが含まれるため
アクセスを制限し、運用保管先へ移すときも公開バケットを使わない。

```powershell
$env:EMBEDDING_PROVIDER = 'gemini'
$env:MAP_BUILD_VERSION = 'islands-gemini-20260908-v1'
python scripts/build_seed_map.py --artifacts output/gemini-v1
python scripts/build_seed_map.py --artifacts output/gemini-v1 --verify
```

Geminiキーは事前にプロセス環境に渡す。`--fast` は品質確認を省くため移行には使わない。
成果物は教師UMAP、encoder、vectorizers、cluster、重心、類似度校正、manifestを一組で生成する。
ビルド完了後も意味類似度と近傍品質を現行評価コーパスでE5と比較し、既存品質ゲートだけでなく
主要指標が下がっていないことを確認する。比較結果が未取得なので現在は移行不可。

準備用プロセスにSupabaseのservice権限を設定してから実行する。

```powershell
$env:MAP_ARTIFACTS_DIR = (Resolve-Path output/gemini-v1).Path
python scripts/migrate_map.py prepare --backup output/e5-before.json --output output/gemini-posts.json
python scripts/migrate_map.py apply --input output/gemini-posts.json
```

2つ目のコマンドはdry-run。prepareはDBを変更しない。ID/本文/updated_at/件数が
準備時から変わっていれば再準備する。保存先が既存なら上書きせず失敗する。
準備時のGemini入力は本番と同じDB cacheに残り、同じ入力の再利用に使う。

## 短時間メンテナンスで切替

1. Geminiコンテナを別image digestでビルドし、Secret・provider・新artifactsを含めて0%候補へデプロイする。まだDBはE5なのでartifact_compatible=falseでよい。
2. 「マップ更新で投稿位置が変わる」ことをアプリ内案内に表示する。外部へのメール等は別途送信指示がない限り送らない。
3. `python scripts/migrate_map.py maintenance on`。直接API/DB/Storageの書き込みが止まったことを確認する。
4. dry-runをもう一度実行し、差分がなければ下記のapplyを実行する。

```powershell
python scripts/migrate_map.py apply --input output/gemini-posts.json --execute
```

RPCはruntimeをロックし、現行版と全live投稿の件数・ID・本文・更新時刻を検査。
計算列とactive_versionを1トランザクションで変更し、1件でも不一致なら全変更を取り消す。
投稿本文・画像・反応・コメント・アカウント・投稿IDは変更しない。maintenanceはONのまま。

5. 候補healthでGeminiモデル・新artifact版・DB版・compatible=trueを確認する。保守中のready=falseは想定どおり。
6. 候補の読み取りAPI・地形・既存投稿を確認する。保守中でも版が一致する候補のGETは許可される。旧版APIは版不一致で503。
7. 候補に100%トラフィックを向け、`maintenance off`。ready=trueを確認する。
8. 本人操作で投稿・画像・反応・コメントのスモークを行う。画面・DB・モデル版、ID/本文/画像/社会データ保持を比較する。

候補のルーティングとSecret設定は現在未実施。新マップ画像、API結果、品質比較をリリース記録に残す。

## 復旧

公開再開前、または公開後に本文・投稿集合が変わっていない場合:

```powershell
python scripts/migrate_map.py maintenance on
python scripts/migrate_map.py rollback --backup output/e5-before.json --output output/rollback-e5.json
python scripts/migrate_map.py apply --input output/rollback-e5.json
python scripts/migrate_map.py apply --input output/rollback-e5.json --execute
```

その後、保存したE5コンテナdigestのリビジョンへトラフィックを戻す。
DB版=旧artifacts版、provider=onnx、compatible=trueを確認してmaintenanceを解除する。
コンテナだけを旧版へ戻すとDBのGemini座標と混ざるため解除しない。

公開後に投稿が追加/削除、本文が編集された場合、通常のrollbackは意図的に停止する。
その場合は旧版のproviderと旧artifactsディレクトリを指定し、`rollback --reproject` を使う。
現在存在する全投稿を旧モデルで再投影するため、新投稿・本文・社会データを維持できる。
例: `$env:EMBEDDING_PROVIDER='onnx'`、`$env:MAP_ARTIFACTS_DIR` に保存したE5ディレクトリを設定し、
`python scripts/migrate_map.py rollback --backup output/e5-before.json --output output/rollback-current.json --reproject`。
生成物をdry-run→applyしてから旧コンテナへ戻す。この復旧経路の実行試験は未実施で、
本番移行前に投稿・反応・画像を失わないリハーサルを行う必要がある。
完全DBバックアップの巻き戻しは新しい社会データを失うため、自動的に選ばない。

## 監視とリリース記録

HTTP200だけでなくhealthのready、store_ok、artifact_compatible、provider/model/版を監視。
503/429率、embedding遅延、Cloud Runメモリ、Supabase応答時間、OTP送信失敗を観測する。
Cloud Monitoringの実チェック・通知先・アラートは未確認。READMEにあるだけで有効とはみなさない。
`keepalive.yml` は手動起動のみで、定期実行を前提にしない。

リリースごとに確認時刻、git SHA、image digest、revision、traffic、resources、manifest hashes、
DB migration履歴、active_version、件数、品質結果、画面比較、復旧結果を記録する。
Secretは版番号までとし、値を記録しない。
