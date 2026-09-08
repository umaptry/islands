# 🏝️ かさなり / islands — API & データベース 完全リファレンス（増補版）

> **2026-09-08 作業ツリーの追加契約（本番未反映）**
>
> 元の資料本文を保持し、新構成は [system_architecture.md](system_architecture.md)、
> 運用は [operations_runbook.md](operations_runbook.md) に統合しています。
> `/api/health` に `embedding`（provider/model/dimensions/task/preprocessing）、
> `artifact_version`, `active_map_version`, `artifact_compatible`, `maintenance`, `ready` を追加。
> `/api/config` に `map_version`、`/api/islands` に実所属 `post_ids` を追加。
> `GET /api/map/bounds` は実投稿の半径込み境界と件数を返します。
> `GET /api/terrain?min_x=0&min_y=0&max_x=1000&max_y=1000&query=&tags=` は
> 192×192のエネルギー配列、境界、revisionを返し、個別地形に追加加算せず置換します。
> 範囲不正・未定義タグは422、DB/embedding失敗と版不一致は503。
> `POST /api/posts` の任意ヘッダー `Idempotency-Key: <UUID>` は同じ本人・入力・キーの
> 再送を同じ投稿IDに収束させます。異なる入力では新IDになります。
> DBの `map_runtime`, `embedding_cache`, `apply_map_version` RPCは追加migrationを参照。
> embedding_cacheと移行RPCは一般ユーザーには公開しません。
> Geminiはベンチマーク専用ではなく明示設定でservingにも使用しますが、
> 現在の同梱artifactsはE5です。Geminiの本番移行は未実施です。

> **このドキュメントの使い方**  
> はじめてこのプロジェクトに触れる方が「何がどう動いているのか」を迷わず理解できるよう設計しています。  
> 各セクションには **「そもそも何のためにあるのか」→「具体的にどう動くのか」→「コード例」** の順で説明をつけました。  
> 知りたい箇所だけ拾い読みしても大丈夫です。

---

## 📚 目次

1. [システム全体像 — このアプリはどう動いているのか](#1-システム全体像)
2. [ER図（データベース構造）— データはどこに、どんな形で保存されるのか](#2-er図データベース構造)
3. [認証の仕組み — 「この人は誰か」をどう判断しているか](#3-認証の仕組み)
4. [REST API エンドポイント一覧（Swagger UI 風）](#4-rest-api-エンドポイント一覧swagger-ui-風)
   - [🔓 公開API（認証不要）](#-公開api認証不要)
   - [🔒 認証必須API](#-認証必須api)
   - [🏠 ローカルモード専用API](#-ローカルモード専用api)
5. [エラーレスポンスと対処法](#5-エラーレスポンスと対処法)
6. [レート制限 — 連続投稿を防ぐ仕組み](#6-レート制限)
7. [用語集 — 迷ったらここを見る](#7-用語集)

---

## 1. システム全体像

### 1.1 アプリが何をするものか（30秒で理解する）

「かさなり」は、**一言の自己紹介を書くだけで、その内容の"意味"から自動的に地図上の位置が決まる**アプリです。  
似たことを書いた人は近くに配置され、人が集まった場所は島になり、島には「そこにいる人たちの言葉」から名前がつきます。

### 1.2 処理の流れ

```mermaid
graph TB
    subgraph "👤 ブラウザ（あなたが操作する画面）"
        UI["地図UI<br/>──────────<br/>地図の表示、リアクション、<br/>コメントなどの操作を担当"]
    end

    subgraph "⚡ FastAPI サーバー（裏方の計算機）"
        API["REST API<br/>──────────<br/>ブラウザからのリクエストを受け付ける窓口"]
        NLP["NLP パイプライン<br/>──────────<br/>日本語の文章を「意味のベクトル」に変換<br/>Sudachi（形態素解析）+ E5-small（意味理解）"]
        ENC["凍結エンコーダ<br/>──────────<br/>448次元のベクトルを<br/>地図上の2次元座標(x, y)に圧縮"]
    end

    subgraph "🗄️ データストア（データの保存場所）"
        SB["Supabase<br/>──────────<br/>本番モードで使用<br/>PostgreSQL + RLS（行レベルセキュリティ）<br/>データは永続的に保存される"]
        MEM["MemoryStore<br/>──────────<br/>ローカルモードで使用<br/>サーバーのメモリ上にデータを保持<br/>⚠️ 再起動で全データ消失"]
    end

    UI -->|"① ユーザーが自己紹介を入力"| API
    API -->|"② テキストを受け取る"| NLP
    NLP -->|"③ 448次元ベクトルを生成"| ENC
    ENC -->|"④ (x, y) 座標を計算"| API
    API -->|"⑤ 座標つきでデータを保存"| SB
    API -.->|"Supabase未設定なら"| MEM
    SB -->|"⑥ 保存完了"| API
    API -->|"⑦ 座標と近くの人の情報を返す"| UI

    style UI fill:#e3f2fd
    style API fill:#fff3e0
    style ENC fill:#fce4ec
    style NLP fill:#fce4ec
    style SB fill:#e8f5e9
    style MEM fill:#f3e5f5
```

### 1.3 2つの動作モード

> [!IMPORTANT]
> 「かさなり」は環境変数の設定に応じて、**2つのまったく異なるモード**で動作します。  
> 開発を始めるとき、最初にどちらのモードで動いているか必ず確認してください。

| | Supabaseモード（本番） | ローカルモード（開発） |
|---|---|---|
| **いつ使う？** | 実際にユーザーに公開するとき | 自分のPCで開発・テストするとき |
| **条件** | `SUPABASE_URL` と `SUPABASE_SERVICE_KEY` が設定済み | どちらかが未設定 |
| **データの読み書き** | ブラウザがSupabaseに直接アクセス（RLSで制御） | すべてサーバー経由 |
| **サーバーの仕事** | 投稿作成・島命名・類似度計算だけ | 上記に加えて全データの読み書き |
| **データの永続性** | PostgreSQL に永続保存 | メモリのみ → **再起動で消える** |
| **認証** | Supabase Auth（Google/Apple OAuth） | メール + 6桁パスコード（ターミナルに表示） |

---

## 2. ER図（データベース構造）

### 2.1 テーブル関連図

> **ER図（Entity-Relationship Diagram）とは？**  
> データベースの中にどんな「箱（テーブル）」があって、それぞれがどう繋がっているかを示す設計図です。  
> 下の図の線は「このテーブルとこのテーブルは関係がある」ことを表しています。

```mermaid
erDiagram
    accounts ||--o{ posts : "1人のユーザーが0件以上の投稿を持つ"
    accounts ||--o{ reactions : "1人のユーザーが0件以上のリアクションを行う"
    accounts ||--o{ comments : "1人のユーザーが0件以上のコメントを書く"
    accounts ||--o{ notifications : "1人のユーザーが0件以上の通知を受け取る"
    accounts ||--o{ reports : "1人のユーザーが0件以上の通報を行う"

    posts ||--o{ reactions : "1つの投稿に対して0件以上のリアクションがつく"
    posts ||--o{ comments : "1つの投稿に対して0件以上のコメントが投稿される"
    posts ||--o{ notifications : "1つの投稿に関連して0件以上の通知が発生する"
    posts ||--o{ reports : "1つの投稿に対して0件以上の通報が寄せられる"

    comments ||--o{ notifications : "コメントが書かれると通知が発生する"
    comments ||--o{ reports : "1つのコメントに対して0件以上の通報が寄せられる"

    accounts {
        uuid id PK "ユーザー固有のID — Supabase認証のauth.usersテーブルと自動連動する"
        text display_name "地図上に表示される名前 — 1文字以上16文字以下で必ず設定が必要"
        text affiliation "所属 — 大学名や会社名など、32文字以下。未設定可（null）"
        text bio "自己紹介文 — 300文字以下の自由記述。投稿の本文とは別物"
        text link_url "外部リンク — SNSやWebサイトのURL、200文字以下。未設定可"
        text icon_id "絵文字アバターの番号 — フロントのEMOJI配列のインデックス。デフォルトは0"
        text avatar_path "アップロードしたアバター画像のパス — 設定するとicon_idより優先される"
        timestamptz created_at "アカウントを最初に作成した日時 — 自動設定される"
        timestamptz updated_at "プロフィールを最後に更新した日時 — 更新時にトリガーで自動更新"
    }

    posts {
        uuid id PK "投稿固有のID — gen_random_uuid()で自動生成される"
        uuid author_id FK "投稿者のユーザーID — accountsテーブルのidと紐づく"
        text body "投稿の本文 — 30文字以上140文字以下。この文章の意味から座標が計算される"
        text_array tags "付与されたタグ — 4種類から複数選択可。気軽に話しかけて等"
        smallint motivation "熱量スライダーの値 — 0がエンジョイ、100がガチ。デフォルト50"
        text image_path "投稿に添付された画像のパス — Supabase Storageに保存される"
        float8 x "地図上のX座標 — 0から1000の範囲。サーバーが計算しクライアントは指定不可"
        float8 y "地図上のY座標 — 0から1000の範囲。サーバーが計算しクライアントは指定不可"
        int2 cluster_id "所属する島のID — 最寄りのシードクラスタから投票で決定"
        jsonb terms "本文から抽出された名詞リスト — 島の命名と共通キーワード表示に使用"
        vector448 vec "448次元の特徴ベクトル — ブラウザからは閲覧不可。意味を数値化したもの"
        vector448 vec_c "中心化済み448次元ベクトル — コサイン類似度の計算に使用される"
        int4 like_count "いいねの累計数 — リアクション追加削除のトリガーで自動更新"
        int4 help_count "手伝えるかもの累計数 — 同上"
        int4 join_count "参加したいの累計数 — 同上"
        int4 comment_count "コメントの累計数 — コメント追加削除のトリガーで自動更新"
        float4 energy "エネルギー値 — motivation + 全リアクション数x5 の自動計算列"
        timestamptz created_at "投稿した日時"
        timestamptz updated_at "最終更新日時 — 編集時にトリガーで自動更新"
        timestamptz deleted_at "論理削除された日時 — NULLなら有効、値があれば削除済み"
    }

    reactions {
        uuid post_id PK_FK "どの投稿に対するリアクションか — postsのidと紐づく"
        uuid actor_id PK_FK "誰がリアクションしたか — accountsのidと紐づく"
        text kind PK "リアクションの種類 — like又はhelp又はjoinの3択"
        timestamptz created_at "リアクションした日時"
    }

    comments {
        uuid id PK "コメント固有のID — 自動生成"
        uuid post_id FK "どの投稿へのコメントか — postsのidと紐づく"
        uuid author_id FK "誰が書いたコメントか — accountsのidと紐づく"
        text body "コメント本文 — 1文字以上500文字以下"
        timestamptz created_at "コメントした日時"
        timestamptz deleted_at "論理削除日時 — NULLなら表示中、値があれば削除済み"
    }

    notifications {
        uuid id PK "通知固有のID — 自動生成"
        uuid recipient_id FK "通知を受け取るユーザーのID — 投稿の作者に届く"
        uuid actor_id FK "通知のきっかけとなった行動をしたユーザーのID"
        uuid post_id FK "通知に関連する投稿のID — 省略可"
        uuid comment_id FK "通知に関連するコメントのID — コメント通知時のみ設定"
        text type "通知の種類 — like又はhelp又はjoin又はcommentの4種"
        timestamptz created_at "通知が発生した日時"
        timestamptz read_at "既読にした日時 — NULLなら未読"
    }

    reports {
        uuid id PK "通報固有のID — 自動生成"
        uuid reporter_id FK "通報したユーザーのID"
        uuid post_id FK "通報対象の投稿ID — 投稿を通報する場合に設定"
        uuid comment_id FK "通報対象のコメントID — コメントを通報する場合に設定"
        text reason "通報理由 — 500文字以下の自由記述。省略可"
        timestamptz created_at "通報した日時"
    }

    energy_cells {
        int4 cell_x PK "セルのX座標 — 地図を20x20の格子に区切ったときの列番号"
        int4 cell_y PK "セルのY座標 — 同上の行番号"
        float4 sum_energy "そのセル内の全投稿のエネルギー合計値"
        int4 post_count "そのセル内の投稿数"
    }
```

### 2.2 各テーブルの役割と設計意図（詳細ガイド）

#### 🧑‍💼 accounts — ユーザーのプロフィール情報

> **日常での比喩**: 名刺のようなもの。名前、所属、自己紹介、連絡先（リンク）を一枚にまとめたものです。

| カラム | なぜ必要か |
|---|---|
| `id` | Supabaseの認証システム（`auth.users`）と連動するので、ログインすれば自動でこのIDが付きます。ユーザーが退会（`auth.users`を削除）すると、`ON DELETE CASCADE` で関連データも自動削除されます。 |
| `display_name` | 地図上に表示される名前です。**唯一の必須項目**で、空にはできません（`CHECK (length BETWEEN 1 AND 16)`）。これがないと地図にドットだけ表示されてしまい、誰だかわかりません。 |
| `icon_id` / `avatar_path` | どちらもアバターですが使い分けがあります。`icon_id` はアプリ内蔵の絵文字から選ぶもの（デフォルト）、`avatar_path` はユーザーが自分の写真をアップロードしたときのパスです。`avatar_path` が設定されていればそちらが優先されます。 |

> [!NOTE]
> **メールアドレスはこのテーブルに保存されません。** メールは `auth.users` 側にのみ存在します。`accounts` テーブルは地図上で誰でも閲覧可能なので、個人情報を守るためにあえて分離しています。

---

#### 📍 posts — 地図上の投稿（このアプリの核心）

> **日常での比喩**: 地図に刺す「ピン」のようなもの。ただし、ピンの位置は自分で選べず、書いた文章の意味がピンの位置を決めます。

| カラムグループ | 含まれるカラム | 何のためにあるか |
|---|---|---|
| **ユーザー入力** | `body`, `tags`, `motivation`, `image_path` | ユーザーが自分で書いたり選んだりした情報 |
| **サーバー計算** | `x`, `y`, `cluster_id`, `terms`, `vec`, `vec_c` | NLPとエンコーダが文章から**自動計算**した情報。ブラウザからは書き込めません |
| **集計値** | `like_count`, `help_count`, `join_count`, `comment_count`, `energy` | データベースのトリガーが**自動で更新**する数値 |
| **メタ情報** | `created_at`, `updated_at`, `deleted_at` | いつ作られ、いつ更新され、いつ消されたか |

**座標の決まり方（簡易図解）**

```
「キャンプで焚き火を囲みながらコーヒーを淹れるのが好きです」
                    ↓
    ┌─── Sudachi で単語に分解 ───┐
    │ キャンプ / 焚き火 / 囲む / │
    │ コーヒー / 淹れる / 好き   │
    └────────────┬───────────────┘
                 ↓
    ┌── 2つのルートで数値化 ──────────────────────────┐
    │                                                  │
    │  ルートA: 単語の出現パターン → TF-IDF → SVD(64d) │
    │  ルートB: 文の意味理解 → E5-small(384d)          │
    │                                                  │
    │  → 合体: [意味×0.65, 語×0.35] → 448次元ベクトル  │
    └────────────────────┬─────────────────────────────┘
                         ↓
    ┌── 凍結エンコーダ(448→2) ──┐
    │ ニューラルネット順伝播     │
    │ → (x=423.56, y=612.33)    │
    └────────────┬──────────────┘
                 ↓
    地図上の座標が確定！
```

> [!WARNING]
> **`vec` と `vec_c` はブラウザから見えない秘密の列です。** データベースの列レベル権限（Column Grants）で `anon` / `authenticated` ロールには `SELECT` 権限が付与されていません。もしこれらが見えたら、ベクトルの逆算で「どんな文章を書けばあの人の隣に表示されるか」がわかってしまうためです。

**`energy`（エネルギー値）は自動計算列（Generated Column）です**

```sql
-- schema.sql から抜粋
energy real GENERATED ALWAYS AS (
    motivation
    + (like_count + help_count + join_count + comment_count) * 5
) STORED
```

この列はデータベースが**勝手に計算して保存**します。開発者が `UPDATE posts SET energy = ...` のように直接値を書き込むことはできません。`motivation` が 75 で、いいねが 3件、コメントが 2件なら：

```
energy = 75 + (3 + 0 + 0 + 2) × 5 = 75 + 25 = 100
```

**論理削除（Soft Delete）について**

投稿を「削除」しても、データベースの行は消えません。`deleted_at` に日時が入るだけです。

```
削除前: deleted_at = NULL     → 地図に表示される ✅
削除後: deleted_at = '2026-09-01T10:00:00Z' → 地図から消える ❌
```

**なぜ物理削除しないのか？** 他の人がくれたコメントやリアクションは**彼らの言葉**であり、投稿者の一存で消すべきではないからです。

---

#### ❤️ reactions — リアクション（いいね・手伝えるかも・参加したい）

> **日常での比喩**: SNSの「いいね」ボタンを3種類に拡張したものです。

**主キーが3列の複合キーであることが設計のポイントです**

```sql
PRIMARY KEY (post_id, actor_id, kind)
```

これにより以下が**データベースレベルで保証**されます：
- 同じ人が同じ投稿に同じ種類のリアクションを **2回できない**（冪等性）
- 同じ人が同じ投稿に**異なる種類のリアクションは複数つけられる**（いいね と 参加したい を同時に）
- 2人のユーザーが同時にリアクションボタンを押しても、重複行にならない

| `kind` の値 | 表示 | 意味 | 効果 |
|---|---|---|---|
| `like` | ❤️ | いいね | `posts.like_count` +1、投稿の `energy` +5 |
| `help` | 🤝 | 手伝えるかも | `posts.help_count` +1、投稿の `energy` +5 |
| `join` | 🙋 | 参加したい | `posts.join_count` +1、投稿の `energy` +5 |

---

#### 💬 comments — 投稿へのコメント

> **日常での比喩**: 掲示板のコメント欄。他のユーザーの投稿に直接メッセージを送れます。

| ポイント | 説明 |
|---|---|
| **長さの制約** | 1文字以上500文字以下。投稿本文（30-140文字）より長く書けます |
| **削除方式** | 論理削除（`deleted_at` に日時を入れる）。RLSポリシーで `deleted_at IS NULL` の行だけ閲覧可能にしています |
| **他人のコメントは？** | 自分が書いたコメントだけ編集・削除できます（`auth.uid() = author_id` のRLSポリシー） |

---

#### 🔔 notifications — 通知

> **日常での比喩**: LINEの「○○さんがメッセージに♡しました」という通知と同じです。

**通知はユーザーが作るものではなく、トリガーが自動生成します。** リアクションやコメントが追加されると、データベースのトリガー関数が自動的に通知行を作成します。

| `type` | いつ発生するか | 誰に届くか |
|---|---|---|
| `like` | 誰かが投稿に「いいね」した | 投稿の著者 |
| `help` | 誰かが投稿に「手伝えるかも」した | 投稿の著者 |
| `join` | 誰かが投稿に「参加したい」した | 投稿の著者 |
| `comment` | 誰かが投稿にコメントを書いた | 投稿の著者 |

> [!TIP]
> **自分の投稿に自分がリアクションしても通知は作られません。** トリガー内で `owner_id <> new.actor_id` をチェックしています。自分で自分に通知しても無意味なので。

**通知のライフサイクル**

```
① リアクションが追加される
   → トリガーが発火
   → notifications テーブルに行が INSERT される（read_at = NULL）

② ユーザーが通知一覧を開く
   → read_at が NULL の行 = 未読通知

③ ユーザーが「既読にする」を押す
   → read_at に現在日時が入る

④ リアクションが取り消される（未読の場合のみ）
   → 対応する通知行が DELETE される
   ※ 既読済みの通知は消えない（「起きたこと」は取り消せない）
```

---

#### 🚨 reports — 通報

> **日常での比喩**: お店の「ご意見箱」のようなもの。不適切な投稿やコメントを運営に知らせます。

- `post_id` か `comment_id` の**少なくとも一方が必須**（`CHECK` 制約あり）
- `reason` は自由記述で省略可能（ボタン1つで通報できるようにするため）
- **通報の閲覧は `service_role` のみ**可能。一般ユーザーや管理画面からは見えません

---

#### 🗺️ energy_cells — 地形の広域キャッシュ

> **日常での比喩**: Google Maps で遠くから見たときの「ぼんやりした地形」。ズームインすると個別の建物が見えるのと同じ原理です。

**なぜ必要か？**

地図を遠くから見ると数千件の投稿が画面に入ります。全件取得すると通信量も処理時間も大きくなります。そこで地図を20×20の「セル」に区切り、各セルに「エネルギー合計」と「投稿数」だけを記録します。

```
1000×1000 の地図 ÷ 20×20 のセルサイズ = 最大50×50 = 2,500セル
```

ブラウザは遠景ではこの2,500行だけ取得して地形を描き、ユーザーがズームインしたら個別の投稿を取得します。

> [!NOTE]
> セルの更新は `on_post_energy_change` トリガーで自動化されています。投稿の追加・更新・削除のたびに、該当セルの `sum_energy` と `post_count` が自動で増減します。投稿が別のセルに移動した場合は、古いセルから引いて新しいセルに足す2ステップで処理されます。

---

### 2.3 テーブル間のリレーション（関係）を理解する

ER図の線の読み方を、具体的なシナリオで説明します。

```
accounts ||--o{ posts    →「1人のユーザーは、0件以上の投稿を持つ」
  ||  = 必ず1つ（アカウントは1つ）
  o{  = 0個以上（投稿はなくてもいい、何個あってもいい）
```

**シナリオ例**: ユーザー「ゆうた」さんの場合

```
accounts (ゆうた)
  ├── posts (焚き火の投稿)
  │     ├── reactions (山田さんの「いいね」)
  │     ├── reactions (鈴木さんの「参加したい」)
  │     ├── comments (山田さん「同じ趣味です！」)
  │     │     └── notifications → ゆうたさんに「コメントが来ました」
  │     └── notifications → ゆうたさんに「いいねされました」×2
  └── posts (プログラミングの投稿)
        └── comments (佐藤さん「どの言語ですか？」)
              └── notifications → ゆうたさんに「コメントが来ました」
```

---

### 2.4 インデックス（検索を速くする仕組み）

> **日常での比喩**: 辞書の「索引」と同じです。1000ページの辞書を最初から読むのではなく、索引で一発でページを見つけます。

| インデックス名 | 対象カラム | 何のためにあるか |
|---|---|---|
| `posts_xy_idx` | `point(x, y)` — GiST | 「画面に映っている範囲の投稿」を座標の矩形検索で高速に取得 |
| `posts_author_idx` | `author_id, created_at DESC` | 「この人の投稿一覧」を新しい順で高速取得。`deleted_at IS NULL` の部分インデックス |
| `posts_live_idx` | `created_at DESC` | 「最新の投稿」を高速取得。削除済みを除外する部分インデックス |
| `posts_vec_c_idx` | `vec_c` — HNSW | 「この投稿に似ている投稿」を448次元コサイン類似度で**近似最近傍探索**（O(log n)で見つかる） |
| `reactions_actor_idx` | `actor_id` | 「自分がリアクションした投稿一覧」を高速取得 |
| `comments_post_idx` | `post_id, created_at` | 「この投稿のコメント一覧」を時系列順で高速取得 |
| `notifications_inbox_idx` | `recipient_id, created_at DESC` | 「自分への通知一覧」を新しい順で取得 |
| `notifications_unread_idx` | `recipient_id` (WHERE `read_at IS NULL`) | 「未読通知の数」を高速カウント |

---

### 2.5 トリガー連鎖（データベースが自動でやること）

> **初心者向け解説**: トリガーとは「あるテーブルに変更が起きたとき、自動的に別の処理を実行する」仕組みです。  
> プログラムで書く代わりにデータベースが自動でやってくれるので、バグが入りにくくなります。

```mermaid
flowchart TD
    subgraph "① リアクションが追加されたとき"
        direction LR
        R1["🖱️ ユーザーが「いいね」を押す"] --> R2["reactions テーブルに INSERT"]
        R2 --> R3["on_reaction_change トリガーが発火"]
        R3 --> R4["posts.like_count を +1 する"]
        R3 --> R5{"投稿者 ≠ 操作者？"}
        R5 -->|"はい"| R6["notifications に通知を INSERT"]
        R5 -->|"いいえ（自分の投稿）"| R7["何もしない"]
        R4 --> R8["energy が自動再計算される"]
        R8 --> R9["on_post_energy_change トリガーが発火"]
        R9 --> R10["energy_cells が更新される"]
    end

    subgraph "② リアクションが取り消されたとき"
        direction LR
        D1["🖱️ ユーザーが「いいね」を解除"] --> D2["reactions テーブルから DELETE"]
        D2 --> D3["on_reaction_change トリガーが発火"]
        D3 --> D4["posts.like_count を -1 する"]
        D3 --> D5{"対応する通知が未読？"}
        D5 -->|"はい"| D6["通知を DELETE"]
        D5 -->|"いいえ（既読済み）"| D7["通知は残す"]
    end

    subgraph "③ コメントが投稿されたとき"
        direction LR
        C1["💬 ユーザーがコメントを書く"] --> C2["comments テーブルに INSERT"]
        C2 --> C3["on_comment_change トリガーが発火"]
        C3 --> C4["posts.comment_count を +1 する"]
        C3 --> C5{"投稿者 ≠ コメント者？"}
        C5 -->|"はい"| C6["notifications に通知を INSERT"]
        C5 -->|"いいえ"| C7["何もしない"]
    end

    subgraph "④ 更新日時の自動更新"
        direction LR
        T1["accounts または posts が UPDATE"] --> T2["touch_updated_at トリガーが発火"]
        T2 --> T3["updated_at を now() に更新"]
    end
```

---

### 2.6 RLSポリシー一覧（誰が何をできるか）

> **RLS（Row Level Security）とは？** データベースの行ごとに「この行は誰が見られるか・書き込めるか」を制御する仕組みです。  
> たとえWebブラウザから直接データベースにアクセスしても、他人のデータを書き換えることはできません。

| テーブル | 操作 | ルール | わかりやすく言うと |
|---|---|---|---|
| **accounts** | SELECT | `USING (true)` | 誰でも全員のプロフィールを閲覧可能 |
| **accounts** | INSERT | `auth.uid() = id` | 自分のアカウントだけ作成可能 |
| **accounts** | UPDATE | `auth.uid() = id` | 自分のプロフィールだけ変更可能 |
| **accounts** | DELETE | `auth.uid() = id` | 自分のアカウントだけ削除可能 |
| **posts** | SELECT | `deleted_at IS NULL` | 削除済みでない投稿だけ閲覧可能 |
| **posts** | INSERT | *(ポリシーなし)* | **ブラウザからは作成不可**（サーバーのみ） |
| **posts** | UPDATE | `auth.uid() = author_id` | 自分の投稿だけ変更可能 |
| **reactions** | SELECT | `USING (true)` | 誰でも全リアクションを閲覧可能 |
| **reactions** | INSERT | `auth.uid() = actor_id` | 自分の名前でだけリアクション可能 |
| **reactions** | DELETE | `auth.uid() = actor_id` | 自分のリアクションだけ取消可能 |
| **comments** | SELECT | `deleted_at IS NULL` | 削除済みでないコメントだけ閲覧可能 |
| **comments** | INSERT | `auth.uid() = author_id` | 自分の名前でだけコメント可能 |
| **comments** | UPDATE | `auth.uid() = author_id` | 自分のコメントだけ編集・削除可能 |
| **notifications** | SELECT | `auth.uid() = recipient_id` | **自分宛の通知だけ**閲覧可能 |
| **notifications** | UPDATE | `auth.uid() = recipient_id` | 自分宛の通知だけ既読にできる |
| **reports** | INSERT | `auth.uid() = reporter_id` | 誰でも通報を送信可能 |
| **reports** | SELECT | *(ポリシーなし)* | **一般ユーザーは通報を閲覧不可** |
| **energy_cells** | SELECT | `USING (true)` | 誰でもセルデータを閲覧可能 |

---

## 3. 認証の仕組み

### 3.1 認証フローの全体像

```mermaid
sequenceDiagram
    participant U as 👤 ユーザー
    participant B as 🌐 ブラウザ
    participant S as ⚡ FastAPIサーバー
    participant A as 🔐 Supabase Auth

    Note over U,A: 【Supabaseモードの場合】
    U->>B: メールアドレスを入力
    B->>A: OTP（ワンタイムパスワード）をリクエスト
    A->>U: メールで6桁コードを送信
    U->>B: 6桁コードを入力
    B->>A: コードを検証
    A->>B: JWT トークンを返す
    B->>S: Authorization: Bearer <JWT> 付きでAPIを呼ぶ
    S->>S: JWT を検証して user_id を特定

    Note over U,A: 【ローカルモードの場合】
    U->>B: メールアドレスを入力
    B->>S: POST /api/local/auth/otp
    S->>S: 6桁コードを生成してターミナルに表示
    S->>B: レスポンスにもコードを含める
    U->>B: 表示されたコードを入力
    B->>S: POST /api/local/auth/verify
    S->>B: 開発用JWTトークンを返す
```

### 3.2 リクエストヘッダーの書き方

認証が必要なエンドポイントには、すべて以下のヘッダーをつけます：

```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

| モード | トークンの取得方法 |
|---|---|
| **Supabase** | Supabase Auth（Google OAuth / Apple OAuth / メールOTP）でログイン後に自動取得 |
| **ローカル** | `POST /api/local/auth/otp` でパスコード発行 → `POST /api/local/auth/verify` でトークン取得 |

> [!NOTE]
> 認証が必要なエンドポイントにトークンなしでアクセスすると、以下が返ります：
> ```json
> { "detail": "ログインしてください。" }
> ```
> ステータスコード: `401 Unauthorized`

---

## 4. REST API エンドポイント一覧（Swagger UI 風）

### 全エンドポイント早見表

> **Swagger UI とは？** API の仕様書を Web ページ上で対話的に閲覧・テストできるツールです。  
> このドキュメントでは同じスタイルで、各エンドポイントの「何を送るか」「何が返るか」を具体的に示しています。

| メソッド | パス | 🔑 認証 | 概要 | いつ使うか |
|---|---|---|---|---|
| `GET` | `/api/config` | ❌ 不要 | クライアント初期化情報 | アプリ起動時に1回だけ呼ぶ |
| `GET` | `/api/health` | ❌ 不要 | サーバー稼働状況 | 死活監視・デバッグ |
| `GET` | `/api/islands` | ❌ 不要 | 島の一覧 | 地図上の島ラベルを描画する |
| `POST` | `/api/posts` | ✅ 必要 | 投稿を作成 | ユーザーが地図にピンを立てる |
| `PATCH` | `/api/posts/{id}` | ✅ 必要 | 投稿を編集 | 本文やタグを書き換える |
| `DELETE` | `/api/posts/{id}` | ✅ 必要 | 投稿を削除 | 地図からピンを取り除く |
| `GET` | `/api/neighbors` | ❌ 不要 | 近い投稿の取得 | プロフィールシートの「似ている人」表示 |
| `GET` | `/api/pair` | ❌ 不要 | 2投稿の類似度 | 2人を選んだときの「似てる度」表示 |
| `GET` | `/api/account/me` | ✅ 必要 | 自分のプロフィール取得 | ログイン直後のプロフィール確認 |
| `PUT` | `/api/account/me` | ✅ 必要 | プロフィール更新 | 名前・所属・自己紹介の編集 |

---

### 🔓 公開API（認証不要）

---

#### `GET /api/config` — クライアント初期化情報の取得

> **いつ使うか**: ブラウザがアプリを起動したとき、**最初に1回だけ**呼びます。  
> **何が返ってくるか**: 地図の座標範囲、地形計算の定数、入力文字数の上限、選択可能なタグの一覧など、**画面を描画するのに必要なすべての設定値**。  
> **なぜサーバーから取得するか**: これらの値はサーバー側の `core/config.py` で一元管理されており、JavaScriptにも同じ値を二重定義すると「片方だけ変えてバグになる」リスクがあるためです。

**リクエスト例**
```http
GET /api/config HTTP/1.1
Host: localhost:7860
```

**レスポンス例** `200 OK`
```json
{
  "mode": "local",
  "supabase": {
    "url": "https://xxxxx.supabase.co",
    "anon_key": "eyJhbG...",
    "bucket": "post-images"
  },
  "oauth": ["google"],
  "world": {
    "min": 0.0,
    "max": 1000.0,
    "seed_bounds": [23.5, 18.2, 976.1, 981.7]
  },
  "energy": {
    "base": 30.0,
    "scale": 0.45,
    "trim": 0.6667,
    "per_interaction": 5,
    "cell_size": 20.0,
    "thresholds": {
      "shallow": 0.05,
      "desert": 30.0,
      "savanna": 50.0,
      "plains": 90.0,
      "forest": 300.0,
      "mountain": 700.0
    }
  },
  "tags": ["気軽に話しかけて", "助けてほしい", "参加者募集中", "仲間募集中"],
  "island_colors": ["#db2777", "#7c3aed", "#0284c7", "..."],
  "limits": {
    "body_min": 30,
    "body_max": 140,
    "name_max": 16,
    "comment_max": 500,
    "bio_max": 300,
    "link_max": 200,
    "motivation_default": 50,
    "map_post_limit": 800,
    "orbit_neighbors": 24,
    "image_bytes": 1048576
  },
  "similarity": {
    "measured_in": "448d-cosine",
    "floor": 0.12,
    "ceiling": 0.85
  }
}
```

**レスポンスフィールドの詳しい説明**

| フィールド | 型 | 何のために使うか |
|---|---|---|
| `mode` | `"local"` \| `"supabase"` | ブラウザが「Supabaseに直接つなぐか、サーバー経由にするか」を判断するフラグ |
| `supabase.url` | `string` | Supabase プロジェクトのURL。ローカルモードでは空文字 |
| `supabase.anon_key` | `string` | ブラウザがSupabaseにアクセスするための公開鍵（秘密鍵ではない） |
| `supabase.bucket` | `string` | 画像アップロード先のストレージバケット名 |
| `oauth` | `string[]` | 有効なOAuthプロバイダー。`["google"]` や `["google", "apple"]` など |
| `world.min` / `world.max` | `number` | 地図の座標範囲。常に `0.0`〜`1000.0` |
| `world.seed_bounds` | `[minX, minY, maxX, maxY]` | シードコーパス（学習に使った1000件の文章）が分布している矩形範囲。カメラの初期位置決定に使用 |
| `energy.thresholds` | `object` | 地形の見た目を決める閾値。たとえば合計エネルギーが 90以上なら「草原」、300以上なら「森」 |
| `tags` | `string[]` | 投稿につけられるタグの選択肢（4種固定） |
| `limits` | `object` | 入力フォームのバリデーションに使う上限値。サーバーとフロントで一致させる必要がある |
| `similarity.measured_in` | `string` | 類似度の計算方式。`"448d-cosine"` = 448次元コサイン類似度 |
| `similarity.floor` / `ceiling` | `number\|null` | コサイン値を「似てる度 0〜100%」に変換するための校正パラメータ |

---

#### `GET /api/health` — サーバー稼働状況の確認

> **いつ使うか**: サーバーが生きているかどうかの死活監視。Supabase無料プランの7日間アイドル停止を防ぐ定期pingにも使います。  
> **何が返ってくるか**: サーバーの基本情報とデータベースの接続状況。

**リクエスト例**
```http
GET /api/health HTTP/1.1
```

**レスポンス例** `200 OK`
```json
{
  "ok": true,
  "seed_count": 1000,
  "regions": 8,
  "store": "supabase",
  "store_ok": true,
  "posts": 42,
  "model_version": "kotoba-map-v1"
}
```

| フィールド | 型 | 何がわかるか |
|---|---|---|
| `ok` | `boolean` | `true` = サーバープロセス自体は正常に動作中 |
| `seed_count` | `integer` | 地図の基盤となるシードコーパスの点数。通常は1000 |
| `regions` | `integer` | 初期状態での島（クラスタ）の数 |
| `store` | `"supabase"` \| `"memory"` | 現在のデータストア種別 |
| `store_ok` | `boolean` | データベースと正常に通信できているか。`false` なら DB 障害の可能性あり |
| `posts` | `integer` \| `null` | 現在の投稿数。DBと通信できない場合は `null` |
| `model_version` | `string` | 使用中のモデルバージョン識別子 |

> [!TIP]
> `ok: true` でも `store_ok: false` の場合、サーバー自体は動いているがデータベースとの通信に問題があります。投稿の作成や編集は一時的にエラーになりますが、しばらく待てば自動復旧することが多いです。

---

#### `GET /api/islands` — 地図上の島（陸地のかたまり）一覧

> **いつ使うか**: 地図上に島の名前ラベルを描画するとき。  
> **何が返ってくるか**: 現在の投稿から計算された島の名前・位置・大きさの一覧。  
> **どう計算されるか**: 影響半径が重なる投稿を Union-Find で推移的にグループ化し、そのグループ内の投稿の名詞をTF-IDFで重みづけして命名します。  
> **キャッシュ**: 結果は60秒間キャッシュされます。島の計算には全投稿の取得とUnion-Findの実行が必要なため、毎リクエストでの再計算を避けています。

**リクエスト例**
```http
GET /api/islands HTTP/1.1
```

**レスポンスヘッダー**
```http
Cache-Control: public, max-age=30
```
CDNがある場合は30秒キャッシュして共有できます。全員が同じ結果を見るためです。

**レスポンス例** `200 OK`
```json
{
  "islands": [
    {
      "name": "焚き火と珈琲の島",
      "centroid": [423.5, 612.3],
      "radius": 85.2,
      "post_count": 12,
      "cluster_ids": [2, 3],
      "top_terms": ["焚き火", "珈琲", "キャンプ"]
    },
    {
      "name": "プログラミング大陸",
      "centroid": [187.1, 345.8],
      "radius": 152.7,
      "post_count": 58,
      "cluster_ids": [0, 1, 4],
      "top_terms": ["Python", "開発", "AI"]
    }
  ]
}
```

| フィールド | 型 | 何を表しているか |
|---|---|---|
| `name` | `string` | 島の名前。投稿に含まれる名詞のうち、TF-IDFスコアが高いもので自動命名。50件以上の投稿を含む島は「大陸」と表示される |
| `centroid` | `[x, y]` | 島の重心座標（島に含まれる全投稿の座標の平均値） |
| `radius` | `number` | 島の大きさの目安（重心から最も遠い投稿までの距離） |
| `post_count` | `integer` | この島の上に立っている投稿の数 |
| `cluster_ids` | `integer[]` | この島に含まれるクラスタのID番号リスト |
| `top_terms` | `string[]` | 島を特徴づけるキーワード上位（名前の元になった単語） |

> [!NOTE]
> 投稿が1件もない地域には島は存在しません。最初は海だけの地図で、人が投稿するにつれて島が生まれ、近い島同士がくっついて大陸になります。

---

#### `GET /api/neighbors` — 意味的に近い投稿のランキング取得

> **いつ使うか**: ある投稿をタップしたときに表示する「似ている人」リスト。  
> **何を基準にランキングするか**: **448次元空間でのコサイン類似度**。地図上の見た目の距離（ピクセル距離）ではありません。  
> **なぜ地図上の距離を使わないか**: 448次元を2次元に圧縮する過程で情報が失われるため、地図上では離れて見えても意味的には近い組み合わせが存在します。実際の測定では、448次元での真の近傍のうち、地図上でも近く見えるのは約34%だけです。

**リクエスト例**
```http
GET /api/neighbors?post=550e8400-e29b-41d4-a716-446655440000&limit=5 HTTP/1.1
```

**パラメータ**

| パラメータ | 型 | 必須 | デフォルト | 制約 | 説明 |
|---|---|---|---|---|---|
| `post` | `string` (UUID) | ✅ | — | — | 基準となる投稿のID |
| `limit` | `integer` | ❌ | `24` | 1〜100 | 取得する近傍の数 |

**レスポンス例** `200 OK`
```json
{
  "post": "550e8400-e29b-41d4-a716-446655440000",
  "island": {
    "name": "焚き火と珈琲の島",
    "centroid": [423.5, 612.3]
  },
  "neighbors": [
    {
      "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "author_id": "a1b2c3d4-...",
      "display_name": "山田太郎",
      "icon_id": "3",
      "avatar_path": null,
      "body": "キャンプで焚き火を囲みながらコーヒーを淹れるのが至福の時間です",
      "tags": ["気軽に話しかけて"],
      "motivation": 70,
      "x": 430.12,
      "y": 618.45,
      "cluster_id": 2,
      "similarity": 82,
      "cosine": 0.741523,
      "shared": ["焚き火", "珈琲"],
      "note": "とても似ています（共通: 焚き火, 珈琲）"
    }
  ]
}
```

**neighbors 配列の各フィールド**

| フィールド | 型 | 何を表しているか |
|---|---|---|
| `similarity` | `integer` \| `null` | **似てる度**（0〜100%）。コサイン類似度を人間にわかりやすいパーセントに変換した値。校正パラメータがない場合は `null` |
| `cosine` | `number` | 生のコサイン類似度（小数6桁）。研究・デバッグ用。この値から `similarity` が計算される |
| `shared` | `string[]` | 2つの投稿に共通する名詞キーワード。IDF（逆文書頻度：珍しい単語ほど高スコア）順にソートされている |
| `note` | `string` | 人間が読むための一言コメント。「とても似ています」「少し似ています」など、`similarity` の値と `shared` の数に応じて自動生成 |

---

#### `GET /api/pair` — 2つの投稿間の類似度と共通点

> **いつ使うか**: 2人のプロフィールシートを並べて「この2人はどれくらい似ているか」を表示するとき。  
> **neighborsとの違い**: `neighbors` は1つの投稿から「近い順ランキング」を返しますが、`pair` は指定した2つの投稿の間の類似度**だけ**を返します。

**リクエスト例**
```http
GET /api/pair?a=550e8400-...&b=7c9e6679-... HTTP/1.1
```

**パラメータ**

| パラメータ | 型 | 必須 | 制約 | 説明 |
|---|---|---|---|---|
| `a` | `string` (UUID) | ✅ | `b` と異なること | 比較する投稿AのID |
| `b` | `string` (UUID) | ✅ | `a` と異なること | 比較する投稿BのID |

**レスポンス例** `200 OK`
```json
{
  "similarity": 72,
  "shared": ["開発", "Python"],
  "note": "かなり似ています（共通: 開発, Python）"
}
```

---

### 🔒 認証必須API

---

#### `POST /api/posts` — 投稿の作成 ⭐ このアプリの核心

> **いつ使うか**: ユーザーが自己紹介を書いて「地図にのせる」ボタンを押したとき。  
> **何が起きるか**: サーバー側で文章を解析し、448次元ベクトルを生成し、凍結エンコーダで2次元座標に変換して保存します。  
> **なぜサーバーでしかできないか**: もしブラウザが座標を送れたら、誰でも好きな場所に自分を配置でき、「近い人＝似た話をしている人」という地図の約束が壊れるからです。

**サーバー内部の処理フロー**

```mermaid
flowchart LR
    A["📝 本文を受け取る<br/>（30-140字）"] --> B["🔤 Sudachi で<br/>形態素解析"]
    B --> C["📊 単語TF-IDF + 文字TF-IDF<br/>→ SVD(64次元)"]
    A --> D["🧠 E5-small(ONNX)<br/>文の意味を384次元に"]
    C --> E["🔗 結合<br/>[意味×0.65, 語×0.35]<br/>= 448次元ベクトル"]
    D --> E
    E --> F["🗺️ 凍結エンコーダ<br/>448→512→256→128→2<br/>（GELU+LayerNorm）"]
    F --> G["📐 等方スケール<br/>→ (x, y) 座標<br/>0-1000の範囲に"]
    G --> H["🏝️ 最寄りの<br/>シード15点から<br/>島IDを投票で決定"]
    H --> I["💾 DB保存<br/>+ 島名再計算<br/>+ 近傍3件を取得"]
```

**前提条件**（これを満たさないとエラーになります）
1. ログイン済みであること（JWTトークンが有効）
2. `display_name` が設定済みであること（先に `PUT /api/account/me` でプロフィールを作成）
3. レート制限に達していないこと（5分間に10回まで）

**リクエスト例**
```http
POST /api/posts HTTP/1.1
Authorization: Bearer eyJhbG...
Content-Type: application/json

{
  "body": "焚き火を囲みながら珈琲を淹れるのが好きです。星空の下で焚き火の音を聞きながら、ゆっくり過ごす時間が最高です。",
  "tags": ["気軽に話しかけて", "仲間募集中"],
  "motivation": 75,
  "image_path": null
}
```

**リクエストボディの各フィールド**

| フィールド | 型 | 必須 | デフォルト | 制約 | 詳しい説明 |
|---|---|---|---|---|---|
| `body` | `string` | ✅ | — | 30〜140文字 | 自己紹介の文章。**この内容だけが座標を決めます。** 短すぎると埋め込みベクトルが弱くなり、無関係な人と重なるリスクがあります |
| `tags` | `string[]` | ❌ | `[]` | 下記4種から | 自分の状況を伝えるバッジ。座標には一切影響しません |
| `motivation` | `integer` | ❌ | `50` | 0〜100 | エンジョイ(0)〜ガチ(100)のスライダー値。座標には影響しないが、`energy` の初期値に直結する |
| `image_path` | `string\|null` | ❌ | `null` | — | 事前にアップロードした画像のパス |

**選択可能なタグ（複数選択OK、順番はシステムが正規化）**

| タグ | 意味 | こういうとき選ぶ |
|---|---|---|
| `気軽に話しかけて` | メッセージ歓迎 | 雑談や質問をもらいたい |
| `助けてほしい` | 困っていることがある | 知識や経験を持つ人を探したい |
| `参加者募集中` | イベント・企画への参加者を探している | ハッカソンや勉強会の告知 |
| `仲間募集中` | 一緒に活動する仲間がほしい | チームやコミュニティの勧誘 |

**レスポンス例** `200 OK`
```json
{
  "id": "a3f4b5c6-...",
  "author_id": "d7e8f9a0-...",
  "body": "焚き火を囲みながら珈琲を淹れるのが好きです。星空の下で焚き火の音を聞きながら、ゆっくり過ごす時間が最高です。",
  "tags": ["気軽に話しかけて", "仲間募集中"],
  "motivation": 75,
  "image_path": null,
  "x": 423.56,
  "y": 612.33,
  "cluster_id": 2,
  "terms": ["焚き火", "珈琲", "星空"],
  "like_count": 0,
  "help_count": 0,
  "join_count": 0,
  "comment_count": 0,
  "energy": 75.0,
  "created_at": "2026-09-01T10:00:00Z",
  "display_name": "ゆうた",
  "icon_id": "3",
  "avatar_path": null,
  "island": {
    "name": "焚き火と珈琲の島",
    "centroid": [423.5, 612.3]
  },
  "neighbors": [
    {
      "id": "7c9e6679-...",
      "display_name": "山田太郎",
      "body": "キャンプで焚き火を...",
      "similarity": 82,
      "cosine": 0.741523,
      "shared": ["焚き火", "珈琲"],
      "note": "とても似ています"
    }
  ]
}
```

> [!WARNING]
> **安全のための自動サニタイズ**: 本文中のURLは `[リンク]` に、メールアドレスは `[メール]` に自動置換されます。地図は全員に公開されるため、意図せず連絡先を公開してしまうのを防ぐ措置です。

---

#### `PATCH /api/posts/{post_id}` — 投稿の編集

> **いつ使うか**: 自分の投稿のテキスト・タグ・熱量・画像を変更したいとき。  
> **⚠️ 重要**: 本文を変更すると**座標が変わります**（投稿が地図上で移動する）。これは仕様通りの動作で、「別のことを書いたなら別の場所に着くべき」という設計思想です。タグ・熱量・画像の変更では座標は動きません。

**リクエスト例**
```http
PATCH /api/posts/a3f4b5c6-... HTTP/1.1
Authorization: Bearer eyJhbG...
Content-Type: application/json

{
  "body": "最近はキャンプより山登りにハマっています。頂上で飲むコーヒーは格別。低山からアルプスまで楽しんでいます。",
  "tags": ["気軽に話しかけて"],
  "motivation": 80
}
```

**リクエストボディ**（すべてオプション。送ったフィールドだけ更新、送らなかったフィールドは変更なし）

| フィールド | 型 | 送信した場合の動作 |
|---|---|---|
| `body` | `string` | 本文を書き換え。**座標も再計算して移動する**。レート制限あり |
| `tags` | `string[]` | タグを差し替え。座標は変わらない |
| `motivation` | `integer` | 熱量を変更。座標は変わらないが `energy` は変わる |
| `image_path` | `string` | 新しい画像パスを設定 |
| `clear_image` | `boolean` | `true` を送ると画像をクリア（`image_path` を `null` にする） |

**レスポンス例** `200 OK`
```json
{
  "id": "a3f4b5c6-...",
  "body": "最近はキャンプより山登りにハマっています。...",
  "x": 310.22,
  "y": 455.67,
  "cluster_id": 5,
  "island": {
    "name": "アウトドア諸島"
  }
}
```

---

#### `DELETE /api/posts/{post_id}` — 投稿の論理削除

> **いつ使うか**: 自分の投稿を地図から取り除きたいとき。  
> **何が起きるか**: データベースの行は消えず、`deleted_at` に日時が記録されます。これにより地図上には表示されなくなりますが、他の人がくれたコメントやリアクションのデータは保持されます。

**リクエスト例**
```http
DELETE /api/posts/a3f4b5c6-... HTTP/1.1
Authorization: Bearer eyJhbG...
```

**レスポンス例** `200 OK`
```json
{ "ok": true }
```

---

#### `GET /api/account/me` — 自分のアカウント情報の取得

> **いつ使うか**: ログイン直後に「この人のプロフィールは設定済みか？」を確認するとき。  
> **重要な挙動**: アカウント行が未作成でもエラーにはなりません。代わりに `"new": true` が返るので、プロフィール設定画面に誘導できます。

**リクエスト例**
```http
GET /api/account/me HTTP/1.1
Authorization: Bearer eyJhbG...
```

**レスポンス例（既存ユーザー）** `200 OK`
```json
{
  "account": {
    "id": "d7e8f9a0-...",
    "display_name": "ゆうた",
    "affiliation": "東京大学",
    "bio": "アウトドア好きのエンジニアです",
    "link_url": "https://example.com",
    "icon_id": "3",
    "avatar_path": null,
    "created_at": "2026-08-15T12:00:00Z"
  },
  "new": false
}
```

**レスポンス例（新規ユーザー）** `200 OK`
```json
{
  "account": null,
  "new": true
}
```

---

#### `PUT /api/account/me` — プロフィールの更新

> **いつ使うか**: 名前・所属・自己紹介・リンク・アイコンを設定または変更するとき。  
> **`null` 送信と未送信の違い**: 
> - フィールドを**送らない**（JSONに含めない）→ そのフィールドは**変更しない**
> - フィールドを `null` で送る → そのフィールドを**クリア（空にする）**

**リクエスト例**
```http
PUT /api/account/me HTTP/1.1
Authorization: Bearer eyJhbG...
Content-Type: application/json

{
  "display_name": "ゆうた",
  "affiliation": "東京大学",
  "bio": "アウトドア好きのエンジニアです",
  "link_url": "https://example.com",
  "icon_id": "3"
}
```

**リクエストボディの各フィールド**

| フィールド | 型 | 制約 | 詳しい説明 |
|---|---|---|---|
| `display_name` | `string` | 1〜16文字 | 地図のピン横に表示される名前。**唯一クリア不可**（空にするとエラー） |
| `affiliation` | `string\|null` | 32文字以下 | 所属（大学・会社・コミュニティ名など） |
| `bio` | `string\|null` | 300文字以下 | 自由な自己紹介文（投稿の本文とは別物） |
| `link_url` | `string\|null` | 200文字以下 | 外部リンク（SNS、Webサイトなど） |
| `icon_id` | `string\|null` | — | 絵文字アバターの番号。フロント側のEMOJI配列のインデックス |
| `avatar_path` | `string\|null` | — | アップロード済みアバター画像のパス。設定すると `icon_id` より優先表示 |

**レスポンス例** `200 OK`
```json
{
  "account": {
    "id": "d7e8f9a0-...",
    "display_name": "ゆうた",
    "affiliation": "東京大学",
    "bio": "アウトドア好きのエンジニアです",
    "link_url": "https://example.com",
    "icon_id": "3",
    "avatar_path": null,
    "created_at": "2026-08-15T12:00:00Z",
    "updated_at": "2026-09-01T10:05:00Z"
  }
}
```

---

### 🏠 ローカルモード専用API

> [!CAUTION]
> 以下のエンドポイントは **`SUPABASE_URL` が未設定のときだけ** 存在します。  
> 本番環境（Supabase接続時）では `404 not found` が返ります。  
> これらは開発時にSupabaseなしでアプリ全機能をテストするための**スタブ（代替品）**です。  
> フラグやパラメータで切り替えるのではなく、環境変数の有無だけで自動判定されるため、本番で誤って有効になるリスクがありません。

---

#### 認証系 — ログインの流れ

##### `POST /api/local/auth/otp` — パスコードの発行

> **何が起きるか**: メールアドレスを送ると、6桁のランダムなパスコードが生成されます。本物のメールサーバーがないため、パスコードは**ターミナル**と**レスポンス本文の両方**に表示されます。有効期限は10分です。

```http
POST /api/local/auth/otp
Content-Type: application/json

{"email": "test@example.com"}
```

```json
{
  "ok": true,
  "code": "482731",
  "note": "ローカルモードのため画面に表示しています"
}
```

##### `POST /api/local/auth/verify` — パスコードの検証とトークン取得

> **何が起きるか**: 発行されたパスコードを送って検証し、成功するとJWTトークンとユーザー情報が返ります。このトークンを `Authorization: Bearer ...` ヘッダーに使います。  
> **同じメールアドレスなら再起動しても同じIDになります**（SHA-256ハッシュでIDを生成しているため）。

```http
POST /api/local/auth/verify
Content-Type: application/json

{"email": "test@example.com", "code": "482731"}
```

```json
{
  "access_token": "eyJhbG...",
  "user": {
    "id": "a1b2c3d4-...",
    "email": "test@example.com"
  }
}
```

---

#### データ読み取り系 — 地図・投稿・アカウントの取得

| メソッド | パス | パラメータ | いつ使うか |
|---|---|---|---|
| `GET` | `/api/local/account/{account_id}` | パスにUUID | 他の人のプロフィールを見るとき |
| `PUT` | `/api/local/account` | Body: AccountPatch | ローカルモードでプロフィールを更新するとき |
| `GET` | `/api/local/map` | `min_x, min_y, max_x, max_y, limit` | 画面に表示する投稿を取得するとき |
| `GET` | `/api/local/cells` | `min_x, min_y, max_x, max_y` | 遠景の地形を描画するとき |
| `GET` | `/api/local/post/{post_id}` | パスにUUID | 1件の投稿の詳細を見るとき |
| `GET` | `/api/local/posts` | `author` (UUID) | 特定ユーザーの全投稿を見るとき |

##### `GET /api/local/map` — 矩形範囲内の投稿取得

> **いつ使うか**: ブラウザのビューポート（画面に映っている範囲）内の投稿を取得するとき。  
> **並び順**: エネルギーが高い順 → 作成日時が新しい順。`limit` を超える投稿がある場合、エネルギーが高い（＝影響範囲が大きく地形に貢献する）投稿が優先されます。

```http
GET /api/local/map?min_x=0&min_y=0&max_x=500&max_y=500&limit=100
```

| パラメータ | 型 | デフォルト | 制約 | 説明 |
|---|---|---|---|---|
| `min_x` | `float` | `0.0` | — | 取得範囲の左端X座標 |
| `min_y` | `float` | `0.0` | — | 取得範囲の下端Y座標 |
| `max_x` | `float` | `1000.0` | — | 取得範囲の右端X座標 |
| `max_y` | `float` | `1000.0` | — | 取得範囲の上端Y座標 |
| `limit` | `integer` | `800` | 1〜2000 | 最大取得件数 |

```json
{
  "posts": [
    {
      "id": "...",
      "author_id": "...",
      "display_name": "ゆうた",
      "icon_id": "3",
      "avatar_path": null,
      "body": "焚き火を囲みながら...",
      "tags": ["気軽に話しかけて"],
      "motivation": 75,
      "image_path": null,
      "x": 423.56,
      "y": 612.33,
      "cluster_id": 2,
      "like_count": 3,
      "help_count": 1,
      "join_count": 0,
      "comment_count": 2,
      "energy": 105.0,
      "created_at": "2026-09-01T10:00:00Z"
    }
  ]
}
```

---

#### ソーシャル機能系 — コメント・リアクション・通知・通報

| メソッド | パス | 🔑 | いつ使うか |
|---|---|---|---|
| `GET` | `/api/local/comments?post={id}` | ❌ | 投稿のコメント一覧を表示 |
| `POST` | `/api/local/comments` | ✅ | コメントを書く |
| `DELETE` | `/api/local/comments/{id}` | ✅ | 自分のコメントを削除 |
| `POST` | `/api/local/reactions` | ✅ | リアクション（いいね等）を追加 |
| `DELETE` | `/api/local/reactions?post_id={id}&kind={kind}` | ✅ | リアクションを取り消し |
| `GET` | `/api/local/reactions/mine` | ✅ | 自分のリアクション一覧 |
| `GET` | `/api/local/notifications` | ✅ | 通知一覧を表示 |
| `POST` | `/api/local/notifications/read` | ✅ | 通知を既読にする |
| `POST` | `/api/local/reports` | ✅ | 不適切コンテンツを通報 |

##### `POST /api/local/comments` — コメントの投稿

```http
POST /api/local/comments
Authorization: Bearer eyJhbG...
Content-Type: application/json

{
  "post_id": "a3f4b5c6-...",
  "body": "同じ趣味です！今度一緒にキャンプ行きませんか？"
}
```

| フィールド | 型 | 制約 | 説明 |
|---|---|---|---|
| `post_id` | `string` (UUID) | 必須 | コメント先の投稿ID |
| `body` | `string` | 1〜500文字 | コメント本文 |

##### `POST /api/local/reactions` — リアクションの追加

```http
POST /api/local/reactions
Authorization: Bearer eyJhbG...
Content-Type: application/json

{
  "post_id": "a3f4b5c6-...",
  "kind": "like"
}
```

| `kind` | 表示 | 意味 | 投稿への効果 |
|---|---|---|---|
| `"like"` | ❤️ | いいね | `like_count` +1、`energy` +5 |
| `"help"` | 🤝 | 手伝えるかも | `help_count` +1、`energy` +5 |
| `"join"` | 🙋 | 参加したい | `join_count` +1、`energy` +5 |

> [!TIP]
> 同じリアクションを2回送っても、主キーの一意制約によりエラーではなく**無視**されます（冪等性）。2回目は「既存」として扱われ、`created: false` が返ります。

##### `POST /api/local/notifications/read` — 通知の既読化

```http
POST /api/local/notifications/read
Authorization: Bearer eyJhbG...
Content-Type: application/json

{
  "ids": ["notif-id-1", "notif-id-2"]
}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `ids` | `string[]` \| `null` | 既読にする通知IDの配列。`null` にすると**全通知を既読**にする |

---

#### ファイルアップロード系 — 画像の保存と取得

##### `POST /api/local/upload` — 画像アップロード

> ローカルモードではサーバーのメモリ（Python の `dict`）に保存されます。**再起動で消えます。**

```http
POST /api/local/upload
Authorization: Bearer eyJhbG...
Content-Type: image/webp

<バイナリデータ>
```

| 制約 | 値 | 超過した場合 |
|---|---|---|
| 最大サイズ | 1 MB (1,048,576 bytes) | `413 画像は1MBまでです。` |
| 許可フォーマット | `image/webp`, `image/jpeg`, `image/png` | `415 対応していない画像形式です。` |

```json
{
  "path": "d7e8f9a0-.../abc123def456",
  "url": "/api/local/image/d7e8f9a0-.../abc123def456"
}
```

##### `GET /api/local/image/{account_id}/{name}` — 保存された画像の取得

> アップロード済み画像をバイナリで返します。`Cache-Control: max-age=3600`（1時間キャッシュ）。

---

## 5. エラーレスポンスと対処法

すべてのエラーは以下の統一フォーマットで返されます：

```json
{
  "detail": "日本語のエラーメッセージ"
}
```

### ステータスコード別の一覧と対処法

| コード | メッセージ例 | 原因 | どうすればいいか |
|---|---|---|---|
| **401** | `ログインしてください。` | Authorizationヘッダーがない、またはJWTの有効期限切れ | ブラウザ側でトークンをリフレッシュするか、再ログインする |
| **403** | `自分の投稿だけ編集できます。` | 他人の投稿を編集・削除しようとした | 自分の投稿IDか確認する。`author_id` と自分の `user_id` が一致する必要がある |
| **404** | `見つかりませんでした。` | 存在しないIDを指定、または論理削除済みの投稿 | IDが正しいか確認。削除済みの投稿は取得できない |
| **409** | `先にプロフィールを作成してください。` | `display_name` 未設定のまま投稿しようとした | 先に `PUT /api/account/me` で `display_name` を設定する |
| **413** | `画像は1MBまでです。` | アップロード画像のサイズが 1MB を超えている | 画像を圧縮するか、解像度を下げる |
| **415** | `対応していない画像形式です。` | webp / jpeg / png 以外の画像を送った | 対応フォーマットに変換する |
| **422** | `本文は30字以上でお願いします` | 入力バリデーションに失敗 | エラーメッセージに従って入力を修正する |
| **422** | `意味のある単語が見つかりませんでした。` | 記号や数字だけの文章、または極端に短い文 | 具体的な名詞や動詞を含む文章に書き直す |
| **422** | `変更点がありません。` | PATCH で何もフィールドを送らなかった | 変更するフィールドを少なくとも1つ含める |
| **429** | `少し時間をおいてからお試しください。` | レート制限超過（5分間に10回以上の投稿操作） | 数分待ってから再試行する |
| **503** | `保存に失敗しました。もう一度...` | データベースの一時的な接続障害 | 数秒待って再試行する。通常は自動復旧する |

---

## 6. レート制限

### 仕様

| 設定項目 | デフォルト値 | 環境変数で変更可能 |
|---|---|---|
| ウィンドウ幅 | **300秒（5分）** | `KOTOBA_RATE_LIMIT_WINDOW` |
| ウィンドウ内の上限回数 | **10回** | `KOTOBA_RATE_LIMIT_MAX` |
| 完全無効化 | — | `KOTOBA_DISABLE_RATE_LIMIT=1` |

### 設計思想

> [!IMPORTANT]
> **レート制限はIPアドレスではなく「アカウント」単位**で適用されます。  
> 
> **なぜIPではないのか？** このアプリは学会やイベント会場で使うことを想定しています。会場のWi-Fiに繋いだ参加者は全員が同じIPアドレスからのアクセスになるため、IPベースの制限だと「4人目が使えない」という問題が起きます（実際に起きました）。  
> 
> アカウントベースにすることで、同じWi-Fiの100人が全員自由に投稿でき、かつ1人の人が連続で投稿を繰り返すことだけを防げます。

### 対象になる操作

| 操作 | 制限あり？ |
|---|---|
| `POST /api/posts`（投稿作成） | ✅ あり |
| `PATCH /api/posts/{id}`（本文変更） | ✅ あり（本文が実際に変わった場合のみ） |
| `PATCH /api/posts/{id}`（タグ・熱量変更） | ❌ なし |
| その他すべての GET/PUT/DELETE | ❌ なし |

---

## 7. 用語集

| 用語 | 意味 |
|---|---|
| **エンコーダ** | 448次元の数値列を2次元の座標に変換するニューラルネットワーク。一度学習して重みを固定（凍結）してあるので「凍結エンコーダ」と呼ぶ |
| **UMAP** | 高次元データを低次元に可視化する手法。このプロジェクトでは教師役として1回だけ使い、その結果をニューラルネットに学習させた |
| **コサイン類似度** | 2つのベクトルの「向きの近さ」を -1〜1 で測る指標。1に近いほど似ている |
| **似てる度** | コサイン類似度を0〜100%に正規化した、ユーザー向けの表示値 |
| **エネルギー** | 投稿の「活気」を数値化したもの。熱量 + リアクション数×5 で計算される |
| **影響半径** | 各投稿が地形に影響を与える円の半径。`(30 + energy × 0.45) × 2/3` で計算される |
| **Union-Find** | 「つながっている要素のグループ」を効率的に管理するデータ構造。影響半径が重なる投稿をグループ化して「島」を作るのに使う |
| **RLS（Row Level Security）** | PostgreSQLの機能。テーブルの各行について「誰がアクセスできるか」を細かく制御する |
| **Generated Column** | データベースが他のカラムの値から自動計算する列。`energy` がこれに該当 |
| **論理削除（Soft Delete）** | データベースの行を実際に消さず、「削除済み」フラグ（`deleted_at`）を立てる方式 |
| **HNSW** | 高次元ベクトルの近似最近傍探索を高速に行うインデックス手法。全件スキャンの O(n) を O(log n) に改善する |
| **PostgREST** | PostgreSQLのテーブルをそのままREST APIとして公開するツール。Supabaseの基盤技術 |
| **service_role** | Supabaseでの最高権限ロール。RLSをバイパスでき、サーバーのみが使用する |
| **IDF（逆文書頻度）** | ある単語がどれだけ「珍しいか」を示す値。多くの文書に出てくる「です」は低く、特定のトピックにしか出ない「焚き火」は高い |

---

## 付録: セキュリティモデルの全体像

```mermaid
flowchart TB
    subgraph "🌐 ブラウザが直接できること（Supabaseモード時）"
        direction TB
        A1["✅ 全投稿の閲覧<br/>（deleted_at IS NULL の行のみ）"]
        A2["✅ 全アカウントの閲覧<br/>（メールアドレスは含まれない）"]
        A3["✅ 自分のリアクションの追加・取消<br/>（actor_id = 自分のID）"]
        A4["✅ 自分のコメントの投稿・編集・削除<br/>（author_id = 自分のID）"]
        A5["✅ 自分宛の通知の閲覧・既読化<br/>（recipient_id = 自分のID）"]
        A6["✅ 通報の送信<br/>（reporter_id = 自分のID）"]
    end

    subgraph "⚡ サーバーだけができること（service_role）"
        direction TB
        B1["🔒 投稿の新規作成<br/>理由: x/y/vec の計算には凍結エンコーダが必要"]
        B2["🔒 投稿の本文編集<br/>理由: 本文変更 = 座標再計算 = エンコーダ必要"]
        B3["🔒 vec / vec_c 列へのアクセス<br/>理由: ベクトルが漏れると「隣に配置される文章」が推測可能"]
        B4["🔒 島の命名<br/>理由: シードコーパスのIDF辞書と日本語トーカナイザが必要"]
        B5["🔒 似てる度の計算<br/>理由: コサイン校正パラメータ（floor/ceiling）が必要"]
        B6["🔒 通報の閲覧<br/>理由: 通報内容は運営だけが見るべき"]
    end

    style A1 fill:#e8f5e9
    style A2 fill:#e8f5e9
    style A3 fill:#e8f5e9
    style A4 fill:#e8f5e9
    style A5 fill:#e8f5e9
    style A6 fill:#e8f5e9
    style B1 fill:#fff3e0
    style B2 fill:#fff3e0
    style B3 fill:#fff3e0
    style B4 fill:#fff3e0
    style B5 fill:#fff3e0
    style B6 fill:#fff3e0
```

> **一言でまとめると**: 「地図上のどこに立つか」を決める計算だけはサーバーが独占しています。もしブラウザが座標を自由に送れたら、誰でも好きな島に自分を配置でき、「近い＝似ている」という地図の約束が崩壊するからです。それ以外の読み書き（閲覧・コメント・リアクション・通知）は、Supabaseモードではブラウザが直接データベースにアクセスし、RLSが「自分のデータだけ操作可能」を保証しています。
