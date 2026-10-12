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
