-- 2026-11-05: LINE の「受け付けました」の案内（M5）。
--
-- 申し込み直後に LINE で「受け付けました」を1通送る（ボタン：会のページを開く／申し込みを取り消す）。
-- 予約は outbound_messages に kind = 'applied'・送る時刻 = 今 で入れ、毎分の予約送信（/api/jobs/tick）が送る。
--
--   * outbound_messages.kind の check に 'applied' を足す（ほかの6つはそのまま）。
--   * 関数 event_queue_applied（サーバーだけ。service_role）：LINE で申し込み中（applied・channel = 'line'）の人に、
--     「受け付けました」の予約を入れる。中止・not_held・終わった会には入れない。同じ人の2回目（取り消して申し込み直し）は
--     予約の行を新しい id で作り直す（もう一度送る）。入れたら true。
--     Python（core/events.py の申し込み）が event_apply のあとに呼ぶ。event_apply は作り直さない。
--
-- 流す順番: M4（20261111000000_events_b.sql）のあと。**このSQLが先、コードが後**。
--   古いコードのまま先に流しても壊れない（古いコードは event_queue_applied を呼ばず、'applied' の行もできない）。
--   新しいコードを先に出しても壊れない（呼べなければ記録だけして、申し込みはそのまま通る。案内が届かないだけ）。
--
-- 足す・作り直すだけで、何度流しても壊れない。1本 = 1 transaction。
-- 戻すときは supabase/rollback/20261112000000_line_applied_rollback.sql（コードを先に戻してから）。
begin;

set local lock_timeout = '3s';
set local statement_timeout = '60s';

-- 1. kind の check（列に付けた名前の無い check は outbound_messages_kind_check という名前になっている。
--    念のため、kind を見ている check を名前に関係なく外してから付け直す）
do $$
declare
  c record;
begin
  for c in
    select con.conname
      from pg_constraint con
     where con.conrelid = 'public.outbound_messages'::regclass
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) like '%kind%'
  loop
    execute format('alter table public.outbound_messages drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.outbound_messages add constraint outbound_messages_kind_check
  check (kind in ('applied', 'week_before', 'day_of', 'after', 'declined', 'event_cancelled', 'event_changed'));

-- 2. 「受け付けました」の予約
create or replace function public.event_queue_applied(p_event uuid, p_account uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1
      from public.event_registrations r
      join public.events e on e.post_id = r.event_id
     where r.event_id = p_event and r.account_id = p_account
       and r.status = 'applied' and r.channel = 'line'
       and e.cancelled_at is null and e.decision is distinct from 'not_held' and e.ends_at > now()
  ) then
    return false;
  end if;
  -- 行を作り直す（id を新しくする）。送る側は id から LINE の再送キーを作り、LINE は同じキーを24時間「送った」と
  -- 覚えている。同じ行を使い回すと、取り消してその日のうちに申し込み直した人に2通目が届かない。
  delete from public.outbound_messages
   where event_id = p_event and account_id = p_account and kind = 'applied';
  insert into public.outbound_messages (event_id, account_id, kind, scheduled_at)
  values (p_event, p_account, 'applied', now());
  return true;
end $$;

-- 3. 権限（必ず先に revoke。Supabase は新しい関数に全員の実行権を自動で付けるため）
revoke all on function public.event_queue_applied(uuid, uuid) from public, anon, authenticated;
grant execute on function public.event_queue_applied(uuid, uuid) to service_role;

commit;
