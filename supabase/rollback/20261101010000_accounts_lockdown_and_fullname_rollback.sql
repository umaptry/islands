-- 戻し用: 20261101010000_accounts_lockdown_and_fullname.sql（accounts を閉じる・フルネーム）を取り消す。
--
-- **supabase/migrations の外に置いている**（CLI は migrations の中のファイルを全部流してしまうため）。
-- 本番では Supabase の SQL エディタで、必要なときだけ流す。コードを先に戻す必要は無い
-- （戻すと accounts はまた誰でも読めるようになるだけ）。
--
-- 戻すもの: accounts_read をまた「誰でも読める」にし、anon の列の読みを social_foundation のとおりに戻す。
-- 新しい3つの列（name_confirmed_at・age_band・job_title）の読みの権限を外す。関数 account_visible・
-- shares_community_with を消す。display_name の長さの制約を 1〜16 字に戻す（not valid: 17字以上の名前が
-- すでに入っていても、この SQL は止まらない。その人は名前を変えるとき 16 字以内にする必要がある）。
-- 戻さないもの: 新しい4つの列とその中身（足しただけで無害。消すとフルネームや年代が失われる）。
--
-- 何度流しても壊れない。
begin;
set local lock_timeout = '3s';
set local statement_timeout = '120s';

drop policy if exists accounts_read on public.accounts;
create policy accounts_read on public.accounts for select using (true);

grant select (id, display_name, affiliation, bio, link_url, icon_id, avatar_path,
              created_at, updated_at, topics, goal, seeking, offering)
  on public.accounts to anon, authenticated;
revoke select (name_confirmed_at, age_band, job_title) on public.accounts from anon, authenticated;

drop function if exists public.account_visible(uuid);
drop function if exists public.shares_community_with(uuid);

alter table public.accounts drop constraint if exists accounts_display_name_check;
alter table public.accounts add constraint accounts_display_name_check
  check (length(display_name) between 1 and 16) not valid;

commit;
