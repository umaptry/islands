-- 戻し用: 20261106000000_events.sql（イベント申し込み M3）を取り消す。
--
-- **supabase/migrations の外に置いている**（CLI は migrations の中のファイルを全部流してしまうため）。
-- 本番では Supabase の SQL エディタで、必要なときだけ流す。**コードを先に戻してから**流す
-- （新しいコードが消えた関数・表を呼ぶと、申し込みの画面が動かなくなる）。
--
-- 戻すもの:
--   * トリガーと関数をすべて消す（会・申し込み・LINE・予約送信・probe）
--   * accounts_invite_guard と account_visible を M3 の前の定義に戻す
--   * notifications_type_check を15種類（M1 のまま）に戻す。event_late / event_cancel / event_cancelled の通知の行は消す
--   * **9つの表を消す（中身も消える）**: events・event_registrations・event_answers・event_meetings・line_links・
--     outbound_messages・line_webhook_events・event_probe_hits・line_pending_friends。
--     申し込みの記録を残したいときは、流す前に自分で書き出しておく（下の確かめる SELECT）。
-- 戻さないもの: 会の投稿に付いていた join の反応（ふつうの参加として残る）、申し込みで作られた accounts の行
--   （created_via = 'event'。消すかは運営の判断）。
--
-- 予約送信（jobs_poke と pg_cron）を流していたら、先に 4_予約送信_pg_cron の「止める」側（本番SQL_第2回a の 3_戻す.sql に入れてある）を流す。
--
-- 確かめる（消える前の件数）:
--   select (select count(*) from public.events) as events, (select count(*) from public.event_registrations) as registrations,
--          (select count(*) from public.line_links) as line_links, (select count(*) from public.outbound_messages) as outbound;
--
-- 何度流しても壊れない。
begin;
set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- 1. トリガー・関数
drop trigger if exists reactions_event_join_guard on public.reactions;
drop trigger if exists events_on_post_delete on public.posts;
drop function if exists public.reactions_event_join_guard();
drop function if exists public.events_on_post_delete();

drop function if exists public.event_create(uuid, uuid, text, timestamptz, timestamptz, text, text, jsonb);
drop function if exists public.event_update(uuid, uuid, jsonb);
drop function if exists public.event_apply(uuid, uuid, jsonb, text, text, jsonb, text);
drop function if exists public.event_cancel_registration(uuid, uuid);
drop function if exists public.event_set_late(uuid, uuid, integer);
drop function if exists public.event_decline(uuid, uuid, uuid);
drop function if exists public.event_answer_vectors(uuid);
drop function if exists public.my_event_registrations(uuid);
drop function if exists public.account_by_line_sub(text);
drop function if exists public.line_link_save(uuid, text, boolean);
drop function if exists public.line_link_attach(uuid, text);
drop function if exists public.line_link_unfollow(text);
drop function if exists public.line_webhook_seen(text);
drop function if exists public.outbound_claim(integer, integer);
drop function if exists public.outbound_done(uuid, boolean, text);
drop function if exists public.event_probe_hit(uuid, text, text, integer, integer);
drop function if exists public.event_cleanup(timestamptz);
drop function if exists public.event_queue_reminders(uuid, uuid);
drop function if exists public.has_live_registration(uuid);
-- jobs_poke は別ファイル（4_予約送信_pg_cron.sql）で作る。入っていれば消す
drop function if exists public.jobs_poke();

-- 2. 守りを M3 の前の定義に戻す（表を消す前に: 関数が表を参照しなくなる）
create or replace function public.accounts_invite_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  only_invited boolean;
begin
  if exists (select 1 from public.accounts a where a.id = new.id) then
    return new;
  end if;
  select (s.value = 'true'::jsonb) into only_invited
    from public.app_settings s where s.key = 'invite_only';
  if not coalesce(only_invited, false) then
    return new;
  end if;
  if exists (select 1 from public.invite_claims c where c.account_id = new.id) then
    return new;
  end if;
  raise exception 'islands は招待制です。コミュニティの招待リンクから登録してください。'
    using errcode = 'P0001', hint = 'invite_required';
end $$;
revoke all on function public.accounts_invite_guard() from public, anon, authenticated;

create or replace function public.account_visible(other uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select other = (select auth.uid())
      or public.shares_community_with(other)
      or exists (select 1 from public.dm_rooms r
                  where (r.user_a = (select auth.uid()) and r.user_b = other)
                     or (r.user_b = (select auth.uid()) and r.user_a = other))
      or exists (select 1 from public.community_join_requests q
                  join public.community_members m on m.community_id = q.community_id
                 where q.account_id = other and q.status = 'pending'
                   and m.account_id = (select auth.uid()) and m.role = 'admin')
$$;
revoke all on function public.account_visible(uuid) from public, anon;
grant execute on function public.account_visible(uuid) to authenticated;

-- 3. 通知の種類を15種類に戻す（新しい3種類の通知の行は先に消す）
delete from public.notifications where type in ('event_late', 'event_cancel', 'event_cancelled');
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('like', 'help', 'join', 'comment', 'reply', 'connection', 'similar', 'island',
                  'quiet_post', 'talk_wish', 'talk_match', 'dm', 'match',
                  'join_request', 'join_approved'));

-- 4. 表（子から先に）
drop table if exists public.event_probe_hits;
drop table if exists public.event_meetings;
drop table if exists public.outbound_messages;
drop table if exists public.event_answers;
drop table if exists public.event_registrations;
drop table if exists public.events;
drop table if exists public.line_webhook_events;
drop table if exists public.line_links;
drop table if exists public.line_pending_friends;

drop function if exists public.event_questions_valid(jsonb);

commit;
