# 実装状態

## 2026-10-06 更新（islands 改修 段1：データの土台）

**手元のみ・本番未反映。** マイグレーション `supabase/migrations/20261006000000_social_foundation.sql` は本番 DB に未適用、コミット・push もしていない。

- プロフィールに話題・目標・探している相手・手伝えることを追加し、保存時に埋め込む（`PUT /api/account/me`）。似ている人の上位5人（`/api/similar-people`）。
- 人と人の線（`/api/connections`）：交流1回で引かれ、同じ2人は1本、取り消すと消える。
- 島の成長点と段、島の追跡と変化の記録（`/api/changes`・`/api/changes/digest`）。
- メッセージへの返信（`reply_to`）、通知の種類 `reply`・`connection`・`similar`・`island`、5分類ごとの push・アプリ内の切り替え（`/api/notification-settings`）、リアクションのまとめ。
- MemoryStore と SupabaseStore の両方に同じ操作を追加。通知画面は新しい種類の文言とアイコンだけ足した（線・島・設定の画面は段2以降）。
- テスト：Python 173件（`tests/test_people_layer.py` を追加）と画面側5件が手元で通る。pgTAP `supabase/tests/04_social_foundation.sql` は手元に Docker がないため CI でだけ動き、**未実行**。
- 重み・境目・期間・公開日（`CONNECTIONS_SINCE`）は仮。`core/config.py` に注釈つきで置いた。
- `supabase/schema.sql` には写していない（正本は `supabase/migrations/`。[構成資料](system_architecture.md) の方針どおり）。

## 2026-09-09 更新

Geminiの本番移行とユーザー依頼によるデータ初期化は実施済み。詳細は [運用手順](operations_runbook.md)。localhost参照の起動画面・登録後ガイド・初回投稿の残差を追加修正し、4幅の比較撮影と16件のブラウザ回帰に成功。差分と意図的に維持する実運用仕様は [デザイン監査](design_audit.md) の最新節を参照。

以下は2026-09-08時点の履歴であり、現在の認証・本番反映状況ではない。

## 2026-09-08 時点の実装状態

**未完了・本番未反映。** 指定フォルダの `npx next dev --webpack` のソースを基準とする。
コミット・push・DB変更・Gemini成果物ビルド・本番デプロイは実施していない。

## 作業ツリーへ追加したもの

- 512pxレイアウト、64px SVGナビ、投稿カード/画像/通知/入口の調整。
- PC400px非モーダルパネル、モバイル50/90dvh、フォーカスとEscape。
- 遷移の待機、選択世代、リスナー破棄、共有反応、投稿下書き保持。
- 実投稿の初期境界、正確な所属の参照、全対象投稿からの地形格子。
- embedding providerの明示、artifactsハッシュ検証、health/configの版表示。
- Geminiの応答検証・再試行制限・永続キャッシュ、投稿の冪等キー。
- DBメンテナンス・Storage制御・移行RPCとprepare/apply/rollbackスクリプト。
- Node/ブラウザ/Python/pgTAPの回帰テスト追加とCIジョブ。
- [画面別監査](design_audit.md)、[構成資料](system_architecture.md)、[運用・復旧手順](operations_runbook.md)。
- プロフィール編集の下書き保持（画面往復で入力を復元、保存成功時にクリア）。
- 登録後ガイダンス画面（3スライド: サービス説明→島の仕組み→初回投稿の案内）。
- 島命名の大量投稿上限到達時にサーバー警告ログを出力。
- 地形グリッドが表示範囲限定であることをステータスに表示。

## 確認できた結果

| 検証 | 結果 |
|---|---|
| 改修前Pythonテスト | 113件成功。変更後の保証には使わない |
| Node回帰 | 5件成功 |
| 画面JavaScript構文 | 21ファイル成功 |
| Playwright設定/テスト構文 | 成功。ブラウザ実行とは別 |
| CI YAML | 7ジョブを正常に解析 |
| 同梱artifacts SHA-256 | 3成果物がmanifestと一致 |
| git diff --check | 成功 |
| 参照ソース固定 | 22ファイルのハッシュを保存 |
| 変更後Pythonテスト | 123件成功（既存113件+新規10件） |
| 変更後JS構文チェック | 22ファイル成功（guidance追加分を含む） |
| 本番health確認 | 新フィールド未反映を確認。6投稿、store=supabase、kotoba-map-v1 |
| gcloud CLI | 両アカウントとも `gen-lang-client-0999045451` に権限なし。`kotoba-map-demo` は削除済み |

## 残作業

1. ~~変更後のPythonテストとDB migration/Storageテストを実行して不具合を直す。~~ → Pythonテスト123件成功。DBテストはDocker環境が必要（未インストール）。
2. webpack指定を確認した参照と、改修版を4幅・同じデータで撮影し、見た目を調整する。
3. ~~登録案内の残り、プロフィール編集の下書き、検索と集計地形の範囲表示、
   大量投稿時の島命名上限など、監査に記載した残差を解消する。~~ → ガイダンス・下書き・地形範囲・命名上限の4件を実装済み。
4. 20回開閉・競合・実機キーボード・戻る/進む・OTP・画像・通信失敗を実測する。
5. E5で外観改修候補を検証してリリースする。
6. Geminiの別artifacts版を構築し、現行コーパスで品質を比較する。
7. 旧DB値/旧artifacts/旧コンテナの復旧リハーサル後、既存投稿を再計算して別リリースする。
8. 実Cloud Run/IAM/Monitoring設定を再取得し、資料の未確認欄を確定する。GCPコンソール経由の手動確認が必要（gcloud CLIは権限不足）。

追加のPython起動・ブラウザ撮影に必要な昇格実行は、自動承認処理の利用上限により停止した。
拒否された実行を別経路で迂回していない。完成画面の比較画像はまだ取得できていない。

## 環境の制約

- Dockerが未インストールのため、Supabase CLIのローカル起動とDBテスト（pgTAP）が実行不可。
- gcloud CLIの認証済みアカウント（`umafree.ai@gmail.com`, `umaptry@gmail.com`）はいずれも
  `gen-lang-client-0999045451` に対する `run.services.get` 権限を持たない。
  旧プロジェクト `kotoba-map-demo` は削除済み。
  Cloud Run/IAM/Monitoring の確認は GCPコンソール（https://console.cloud.google.com/）経由が必要。
