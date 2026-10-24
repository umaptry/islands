# 「コミュニティの投稿はメンバーだけが読める」の SQL を流す手順（運営向けメモ）

守るもの: コミュニティに属する投稿は、そのコミュニティのメンバーだけが読める（ログインしていない人・メンバーでない人は、
表・関数・Realtime・画像の一覧のどこからも読めない）。DB の鍵（RLS）と、Python の門（`app_settings.members_only`）の二重。

## 出す順番（SQL はすべて Supabase の SQL エディタで流す）

1. **前提**: PR #16 の2つの SQL（talk_and_dm・communities）が流れ済みで、最初のコミュニティ（BAR）があり、
   今ある投稿とアカウントがその中にいること（`20261026010000` の ③④）。
2. **FILE 1**: `supabase/migrations/20261027000000_members_only_prep.sql`。足すだけ。今のコードはそのまま動く。何度流しても壊れない。
3. **コードを出す**（PR を main へ）。スイッチ `members_only` は false のままなので、見え方は何も変わらない。
4. **FILE 2**: `supabase/migrations/20261027010000_members_only_lockdown.sql`。**1回の transaction**で締め、
   最後に `members_only = true` にする。流す前に community_id が null の投稿が残っていると、途中で止まって何も変えない
   （④の update をもう一度流してから、流し直す）。
5. **60秒待つ**。Cloud Run の各インスタンスはスイッチを最大15秒覚えている（古い値の間は、サーバーの経路が
   まだ「開いた側」で答える）。`/api/islands` の `Cache-Control: public, max-age=30` もブラウザに残る。
   その間に作られた community_id が null の投稿が無いか、下の「流す前のチェック」の1つ目をもう一度確かめ、
   あれば④の update を流す。**60秒たち、確認が済んでから「閉じた」と数える**。
6. 確かめる（下）。

会の前日と当日は何も流さない・出さない。

## 流す前のチェック（結果の目安）

```sql
select count(*) from public.communities;   -- いくつでもよい。古い島・島の通知は投稿が一番多いコミュニティ（同数なら slug 'bar'）のものとして残る
select count(*) from public.posts where community_id is null and deleted_at is null;   -- 0
select a.id from public.accounts a
 where not exists (select 1 from public.community_members m where m.account_id = a.id); -- 入れ忘れの人。意図した人だけ
select tablename from pg_publication_tables where pubname = 'supabase_realtime';         -- notifications だけ
```

## 流したあとの確かめ（anon キーで）

- `/rest/v1/posts`・`comments`・`reactions`・`communities`・`notifications` → 401 か空。
- `rpc/community_map_posts`・`rpc/map_posts`・`rpc/map_cells` → `[]`。
- `rpc/nearest_posts`・`rpc/post_terms`・`rpc/in_community`・`rpc/map_posts_for_community` → permission denied。
- 画像の一覧（storage の list）→ 空。部外者としてログインした人でも、他人のフォルダは空。
- メンバーのログインでは、自分のコミュニティの投稿だけが見える。招待を使った直後から読める。

## 戻す（コードの出し直しはいらない）

`supabase/rollback/20261027010000_members_only_rollback.sql` を流す。今の（締める前の）動きに戻り、
`members_only` が false になる。もう一度締めるときは FILE 2 を流し直す。
rollback は `supabase/migrations` の外に置いている（CLI は migrations の中を全部流してしまうため）。

## 知っておくこと

- **締め直す順番は「④の update（community_id が null の投稿を BAR へ）→ FILE 2」だけ**。戻したあとや、
  スイッチを切り替える窓のあいだに null の投稿が増えていると、FILE 2 は何も変えずに止まる。
- FILE 2 を流し直すと、community_id の無い島・島の通知の始末をもう一度行う（あれば BAR のものにする）。
  外部キーは、すでに `on delete restrict` なら触らない（全件の検証をしない）。
- 島・静かな投稿・似た投稿の通知は、community_id が無い行は誰にも読めない（古いインスタンスが書いても読めない）。
- FILE 1 は `nearest_posts` と `pair_similarity` の権限を service_role だけにする（以前は anon・authenticated にも付いていた）。
  壊れたわけではなく意図した変更。戻し用 SQL はこの権限を戻さない（安全側）。
- `/api/config`（ログイン無しで読める）の `radius_factor` は、スイッチ true のあいだ常に 1.0。コミュニティごとの値は、
  メンバーだけが呼べる `/api/islands` が返す。

- 画像は、URL を知っている人なら開ける（入れ物は公開のまま。一覧だけを自分のフォルダに絞った）。非公開の入れ物は後日。
- 抜けた人は、自分の投稿の行だけ読める・直せる（自分のページ）。そのコミュニティの他のものは読めない。
- community_id が null の投稿は、書いた本人にだけ見える。
- 古い画面は、島・光の強さの表を読むと 0 件が返る（エラーにはならない）。
- FILE 2 は、コミュニティが2つ以上あるとき、どのコミュニティのものか分からない古い島・島の通知を消す
  （島は次の更新で作り直される）。1つだけなら、そこのものとして残す。
- 投稿があるコミュニティは消せない（外部キー `on delete restrict`）。
- pgTAP: `supabase/tests/13_members_only.sql`（CI の `supabase test db` が流す）。
