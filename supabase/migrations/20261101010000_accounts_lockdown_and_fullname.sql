-- 2026-11-01: accounts を閉じる・フルネーム（名前の長さ 24 字）・年代・職種。第1回の M2。
--
-- 設計: 設計_イベント申し込み D（2-2 / 8 章 16）、E の 9・16。
--
--   * いままで accounts は、ログインしていない人も含めて誰でも読めた（accounts_read が using (true)、anon にも
--     列の読みを許可）。これを「本人」「同じコミュニティのメンバー」「自分と DM の部屋がある相手」だけにする。
--     anon は列の権限は残すが、行を見せる policy が無いので常に0行（エラーにならない）。サーバー（service_role）は今までどおり読める。
--   * accounts に name_confirmed_at / age_band / job_title / created_via を足す。
--       name_confirmed_at・age_band・job_title: authenticated が読める列（行の絞り込みは accounts_read）。
--       created_via: 読ませない。この4つとも、ブラウザからは書けない（サーバーだけが書く）。
--   * display_name の長さを 1〜16 から 1〜24 に（まとめ役の決定。フルネームのため）。
--   * 関数 shares_community_with(other) / account_visible(other)（ブラウザ用。security definer）。
--       account_visible は M2 の時点では「本人・同じコミュニティ・DM の相手」。会の主催者に見える登録者は
--       M3（events）で作り直して足す。
--
-- **古いコード（今の main）のままこの SQL を流すと、ブラウザが accounts を直接読む所の見え方が変わる**:
--   同じコミュニティの人・DM の相手・自分は今までどおり読める。コミュニティの外の人の名前・アイコンは読めなくなり、
--   画面は「名前が空」の扱いになる。ログインしていない人（招待リンクの画面など）は accounts が常に0行だが、
--   招待の画面は check_invite（security definer）だけを使うので影響しない。洗い出しは作業報告を参照。
--
-- 足す・作り直すだけで、何度流しても壊れない。1本 = 1 transaction。
-- 戻すときは supabase/rollback/20261101010000_accounts_lockdown_and_fullname_rollback.sql。
begin;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- ===========================================================================
-- 1. 列と制約
-- ===========================================================================
alter table public.accounts
  add column if not exists name_confirmed_at timestamptz,
  add column if not exists age_band   text check (age_band is null or age_band in ('10s', '20s', '30s', '40s', '50s', '60s')),
  add column if not exists job_title  text check (job_title is null or length(job_title) <= 32),
  add column if not exists created_via text check (created_via is null or created_via = 'event');

-- display_name: 1〜24 字（フルネーム用）。広げるだけなので、今ある名前はすべて通る。
alter table public.accounts drop constraint if exists accounts_display_name_check;
alter table public.accounts add constraint accounts_display_name_check
  check (length(display_name) between 1 and 24);

-- ===========================================================================
-- 2. 「この人の名前を読んでよいか」の関数（ブラウザ用。自分を基準に答える）
-- ===========================================================================
-- 自分が入っているコミュニティのどれかに other も入っているか。
create or replace function public.shares_community_with(other uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1
                   from public.community_members a
                   join public.community_members b on b.community_id = a.community_id
                  where a.account_id = (select auth.uid()) and b.account_id = other)
$$;

-- accounts の行を読んでよいか: 本人、または同じコミュニティ、または自分と DM の部屋がある相手
-- （E の 9: DM の相手には、コミュニティが違っても名前とアイコンを見せる）。
create or replace function public.account_visible(other uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select other = (select auth.uid())
      or public.shares_community_with(other)
      or exists (select 1 from public.dm_rooms r
                  where (r.user_a = (select auth.uid()) and r.user_b = other)
                     or (r.user_b = (select auth.uid()) and r.user_a = other))
$$;

revoke all on function public.shares_community_with(uuid) from public, anon;
revoke all on function public.account_visible(uuid)       from public, anon;
grant execute on function public.shares_community_with(uuid) to authenticated;
grant execute on function public.account_visible(uuid)       to authenticated;

-- ===========================================================================
-- 3. accounts を閉じる
-- ===========================================================================
drop policy if exists accounts_read on public.accounts;
create policy accounts_read on public.accounts for select to authenticated
  using (public.account_visible(id));

-- anon の列の権限は、authenticated と同じ列にそろえて残す（外すと、ログイン前に posts などを accounts の埋め込みで
-- 読む呼び出しが、0行ではなく permission denied になる。PostgREST は埋め込み先の列の権限を計画時に確かめるため）。
-- anon 用の policy は作らない: accounts_read は authenticated だけなので、anon は常に0行（エラーにならない）。
-- 新しい列: name_confirmed_at・age_band・job_title は anon にも select を付ける（行が0なので何も見えない）。
-- created_via はどちらにも付けない。書く権限は足さない（サーバーだけが書く）。
grant select (name_confirmed_at, age_band, job_title) on public.accounts to anon, authenticated;

commit;
