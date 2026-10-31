-- 2026-10-31: DM に「既読」を付ける（LINE のように、相手が部屋を開いたことが自分の画面に出る）。
--
--   * dm_reads   部屋ごと・人ごとに「どこまで読んだか」の時刻を1行だけ持つ（主キーが (room_id, user_id)）。
--                クライアントには読む権限も書く権限も無い（RLS は有効、policy は「だれにも通さない」
--                dm_reads_none の1つだけ）。関数だけが読み書きする。部屋が消えたら一緒に消える。
--   * 関数 mark_dm_read(room)        自分がこの部屋を読んだ時刻を now() にする（戻らない: greatest(前, now())）。
--                                    部屋の2人のどちらかで、ブロックが無いときだけ記録する。それ以外は
--                                    エラーも出さず何もしない（部屋があるかどうか、ブロックされたかどうかを教えない）。
--   * 関数 dm_partner_read_at(room)  相手の読んだ時刻を返す。部屋の2人のどちらかのときだけ。
--                                    それ以外・まだ読んでいないときは null。
--                                    ブロック中でも、すでに記録してある時刻は返す（消すと、ブロックされたことが
--                                    相手に分かってしまうため）。ブロック中は mark_dm_read が時刻を進めないので、
--                                    ブロック後に送ったものにだけ既読が付かない（LINE と同じ）。
--
-- 通知は出さない（notifications に書かない・プッシュしない）。DM の一覧のプレビューや未読も変わらない。
-- 画面は、部屋を開いたとき（と開いている間の5秒ごとの確認）に mark_dm_read を呼び、dm_partner_read_at で
-- 相手の時刻を読み、それより前に自分が送った吹き出しに「既読」を出す。
--
-- 足すだけの変更で、何度流しても壊れない。古いコードは新しい表も関数も使わないので、そのまま動く。
-- コードより前でも後でもよい。流すまでは、新しいコードが関数が無い（PGRST202 / 404）ことを黙って受け止め、
-- 「既読」を出さない。
-- 戻すときは supabase/rollback/20261031010000_dm_read_rollback.sql を流す（コードだけ戻しても無害）。
--
-- 保守モード（check_map_maintenance）のトリガーは、新しい表には付けない（dm_reactions と同じ理由）。
begin;

-- ===========================================================================
-- 1. Table
-- ===========================================================================
create table if not exists public.dm_reads (
  room_id uuid not null references public.dm_rooms (id) on delete cascade,
  user_id uuid not null references public.accounts (id) on delete cascade,
  read_at timestamptz not null,
  primary key (room_id, user_id)
);

-- ===========================================================================
-- 2. Privileges and row level security
-- ===========================================================================
-- policy は「だれにも通さない」1つだけ: authenticated / anon は表を直接は読めも書けもしない。
-- 関数（security definer）だけが触る。
alter table public.dm_reads enable row level security;
revoke all on public.dm_reads from anon, authenticated;
grant all on public.dm_reads to service_role;
drop policy if exists dm_reads_none on public.dm_reads;
create policy dm_reads_none on public.dm_reads for all using (false) with check (false);

-- ===========================================================================
-- 3. What the browser calls (JWT of the signed-in person)
-- ===========================================================================
-- 自分の「読んだ時刻」を now() にする。前より戻らない。返り値は無い。
create or replace function public.mark_dm_read(room uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  ua uuid;
  ub uuid;
begin
  if me is null then
    return;
  end if;
  select r.user_a, r.user_b into ua, ub from public.dm_rooms r where r.id = room;
  if not found or me not in (ua, ub) or public.talk_blocked(ua, ub) then
    return;
  end if;
  insert into public.dm_reads (room_id, user_id, read_at)
  values (room, me, now())
  on conflict (room_id, user_id) do update set read_at = greatest(public.dm_reads.read_at, excluded.read_at);
end $$;

-- 相手が最後に読んだ時刻。部屋の2人でないとき・まだのときは null。
-- ブロック中も、記録済みの時刻はそのまま返す（ブロックしたことを相手に知らせない）。
create or replace function public.dm_partner_read_at(room uuid)
returns timestamptz
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  ua uuid;
  ub uuid;
  seen timestamptz;
begin
  if me is null then
    return null;
  end if;
  select r.user_a, r.user_b into ua, ub from public.dm_rooms r where r.id = room;
  if not found or me not in (ua, ub) then
    return null;
  end if;
  select d.read_at into seen from public.dm_reads d
   where d.room_id = room and d.user_id = case when me = ua then ub else ua end;
  return seen;
end $$;

revoke all on function public.mark_dm_read(uuid) from public, anon;
grant execute on function public.mark_dm_read(uuid) to authenticated;
revoke all on function public.dm_partner_read_at(uuid) from public, anon;
grant execute on function public.dm_partner_read_at(uuid) to authenticated;

commit;
