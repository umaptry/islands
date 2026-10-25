# メンバー限定の投稿: Python サーバー側のきまり

コミュニティの投稿は、そのコミュニティのメンバーだけが読めます。データベース側（RLS）は
`supabase/migrations/20261027000000_members_only_prep.sql` と `...010000_members_only_lockdown.sql`、
Python 側はこの文書の通りです。サーバーはサービスキーで動くので、データベースの鍵は Python の道には
効きません。だから Python 側にも「門」が1つあります。

## スイッチ

`app_settings.members_only`（既定 false）。ロックダウンの SQL がトランザクションの最後で true にします。
戻しの SQL は false にします。サーバーは `store.members_only()` で読み、15 秒だけ覚えます。

- false の間は、どの経路も今までと同じ答えを返します（このスイッチだけを入れたコードを先に出せます）。
- true の間は、読めないと **503**（`MEMBERS_ONLY_UNAVAILABLE`）。「たぶん false」と決めません。
- true の間は `communities_on()`（コミュニティ表の確認。起動直後の一時的な失敗で False を返す）を見ません。

## 門（app.py）

| 関数 | 働き |
| --- | --- |
| `members_only_on()` | スイッチ。読めなければ 503 |
| `viewer_communities(user)` | 今のメンバー所属を毎回読む（覚えない。招待を使った直後から読める） |
| `require_member(user, cid)` | 所属していなければ 404。「投稿がない」ときと同じ答え |
| `community_param(user, ?community=)` | 読み取りの `community` 必須（なければ 422）+ `require_member` |
| `member_post(user, post_id)` | メンバーとして読める投稿。作者でも**抜けていれば 404** |
| `only_community_of(user, named)` | 書き込み先。指定なしでコミュニティが1つならそこ、複数なら 422、0 なら 403 |

投稿を作った人が抜けたあとも読めるのは、**自分の投稿の行**（`/api/local/post/{id}`、自分のページ、
PATCH・DELETE）だけです。近くの投稿・ペア・足あと・島・コメント・反応・通知は「メンバーであること」
で決まり、作者であることは数えません。`community_id` が NULL の投稿は作者だけが読めます。

## 経路ごとの決まり（スイッチ true のとき）

- ログイン必須（なければ 401）: `/api/islands` `/api/connections` `/api/similar-people`
  `/api/people/{id}/card` `/api/changes` `/api/changes/digest` `/api/map/bounds` `/api/terrain`
  `/api/neighbors` `/api/pair` `/api/posts/{id}/view` と `/api/local/*` の読み取りすべて。
- `/api/islands` `/api/map/bounds` `/api/terrain`: `?community=` 必須。島・キャッシュ・光の強さ（reach）・
  追跡・名づけはコミュニティごと。`Cache-Control: private, no-store`。
- `/api/connections`: コミュニティ指定なしは「自分の所属すべて」の線。`?person=` も自分の所属の線だけ。
- `/api/similar-people`: `?account=` は無視（自分のことだけ）。候補と重心は自分の所属コミュニティから。
- `/api/people/{id}/card`: `?viewer=` は無視。投稿・島・線は**見る人の所属**にある分だけ（自分のカードは自分の全投稿）。
  共通のコミュニティがなければ、プロフィールだけ（`post_count` 0）。
- `POST /api/posts`: コミュニティ必須。近くの投稿・島はそのコミュニティだけ。
- `POST /api/posts/preview`: 本文の `community_id`（省略すると所属が1つならそこ）。
- `PATCH /api/posts/{id}`: 他人の投稿と存在しない投稿はどちらも同じ 404（スイッチ false の間は従来の 403）。
- `/api/health`: 投稿数を返さない（`posts: null`）。`/api/config`: `energy.radius_factor` は小数1桁に丸める。
- 通知: 島・静かな投稿の通知はコミュニティごとに作り、今もメンバーの人にだけ送り、`community_id` を書く。
  push は送る直前に、受け取る人が通知のコミュニティにまだいるか確かめて、いなければ捨てる。
  push の文には投稿の本文を入れず、同じ投稿への反応をまとめる `tag` はハッシュにする。
  「似た人」通知は止めたまま（`SIMILAR_NOTIFY_ENABLED = False`）。
- 全体に対して投稿から作る値は、コミュニティなしでは作りません。`list_terms` `terrain_posts` `count_posts`
  `nearest_posts` `nearest_to_vector` `post_centroids` を `community=None` で呼ぶと `ValueError`
  （ストアが true を知っているとき）。

## ストアの約束（SupabaseStore / MemoryStore 共通）

- `members_only()` / `viewer_communities(account)` / `community_member_ids(cid)` / `community_ids()`
- `list_terms(limit, community=None)`（`TERM_COLUMNS` に `community_id`）、`terrain_posts(community=None)`、
  `count_posts(community=None, everything=False)`、`post_centroids(community=None)`
- `nearest_posts(post_id, k, community=None)` → RPC `nearest_posts(from_post, k, p_community)`
- `nearest_to_vector(vector, k, community=None)` → RPC `nearest_to_vector(origin, k, p_community)`
- `post_centroids(community)` → RPC `account_post_centroids(p_community)`
- `map_posts_for_community(community, min_x, min_y, max_x, max_y, limit)` → RPC `map_posts_for_community`（サービス専用）
- `island_states(active_only, communities=None)` / `list_island_events(since, limit, island_ids, communities=None)`
  は `community_id in (...)` で絞る。島・イベント・通知の行に `community_id` を書くのはスイッチ true の間だけ
  （SQL の準備が済む前のデータベースでも新しいコードが動くように）。

## 手元モード（`/api/local/*`）

`/api/local/*` は本番では 404（`require_local`）。テスト用に SQL の方針を Python で写したものです。
`MemoryStore` の読み取りは `viewer=` を受け取り、スイッチ true のときだけ SQL の方針と同じ絞り込みをします
（`viewer` を渡さない＝サーバーのキーは絞り込みなし）。

- 投稿の行（`get_post`）: メンバー、または作者。コミュニティなしの投稿は作者だけ。
- コメント・反応・参加者・通知・通報・DM の抜粋・近くの投稿・書き込み: **メンバーだけ**（作者であることは数えない）。
  ただし自分の反応の行は常に読める（抜けたあとでも取り消せる）。
- `map_cells` はスイッチ true の間、だれにも空を返す（コミュニティごとの版は Phase B）。
- 画像: オブジェクトの URL は今までどおり開ける。`/api/local/storage/list` は自分のフォルダだけ。
- 開発用: `POST /api/local/settings/members-only {"value": true}`、`POST /api/local/communities/{id}/leave`、
  起動時の環境変数 `ISLANDS_LOCAL_MEMBERS_ONLY=1`。

## テスト

`tests/test_members_only.py`（匿名・部外者・他コミュニティのメンバー・抜けた人・メンバーの5通り、
スイッチの入り切り、全ルートの一覧、503、SupabaseStore の呼び方）。pgTAP は
`supabase/tests/13_members_only.sql`（CI で `supabase test db`）が受け持ちます。


## 画面側（web/）

画面は `/api/config` の `features.members_only`（`members_only_quiet()`。読めないときは true）を見て、切り替わります。
false の間の見え方は今までと同じです（登録せずにマップを見るボタンも、ログインなしの地図もそのまま）。

- 読み取りはすべてセッションつき。島・地形は `?community=<いま見ているコミュニティ>`、線はコミュニティ指定つき、
  近くの人・カード・足あとは投稿から決まります。試し書き（`/api/posts/preview`）も `community_id` を送ります。
- ログインなし: ようこそ画面から「登録せずにマップを見てみる」が消え、招待リンクから参加する旨の1行が出ます。
  `#/map` は地図の代わりに案内だけ（読み込みは何も走らず、コンソールにエラーも出ません）。
- `#/map?post=<id>` が読めない（ログインなし・メンバーでない・抜けた・投稿がない）ときは、どれも
  「このコミュニティのメンバーだけが見られます」。存在するかどうかは分かりません。'viewing'（読むだけ）は使いません。
  通信が切れたり、サーバーが不調なだけのときは、この案内にせず、投稿のシートが読み込めない旨を言います。
- 招待 `#/invite/:code?post=<id>`: 入ったあと、その投稿が開きます。
- プロフィール: 他の人のページは共通のコミュニティの投稿だけ（「共通のコミュニティの投稿だけが表示されます」）。
  自分のページは全部、投稿ごとにコミュニティ名が小さく付きます。
- 通知: 行ごとにコミュニティ名が小さく付きます（通知の `community_id`、なければ投稿のコミュニティ）。
  「話してみたい」の行と DM の行は出しません。押すと、そのコミュニティの地図に切り替わって投稿が開きます。
- テスト: `tests/frontend/members-only-rules.test.mjs`、`tests/browser/members-only.spec.mjs`
  （スイッチ「入」は `ISLANDS_LOCAL_MEMBERS_ONLY=1` で起動した手元モードでだけ動き、「切」のサーバーではスキップされます）。
