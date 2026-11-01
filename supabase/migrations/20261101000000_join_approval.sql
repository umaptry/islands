-- 2026-11-01: 承認制（参加の申し込み）・入り方の記録・招待に会を付ける（?post= の穴）。第1回の M1。
--
-- 設計: 設計_本番のあと_承認制とつながり A（2-1）と 設計_イベント申し込み D（2-1 / 1-2 / 1-4 / 8 章）。
--
--   * community_join_requests  承認待ち（pending）と断った人（rejected）。メンバー表とは別の表。
--                              consent_version = 同意した規約の版（E の 19）。全拒否（関数とトリガーだけが触る）。
--   * join_request_notices     「管理者に最後に知らせた時刻」（人 × 会）。取り消しても消さず、承認・断る・
--                              オフのリンクで入ったときに消す。24時間に1回の間引きはこの表で数える。全拒否。
--   * community_removals       外した人の記録。この回では「承認の中で外した人を読む」ためだけに作る
--                              （外す・戻すの関数は M5）。全拒否。
--   * community_invites        needs_approval（承認のスイッチ）、post_id（ふつうの招待に会を付ける）を足す。
--   * community_members        joined_via（founder / invite / approval / event）、invite_id、event_post_id を足す。
--                              今ある行: 管理者は founder、それ以外は invite で埋める（足した瞬間の1回だけ）。
--   * 関数                     check_invite（5キー）・claim_invite(code, consent)・create_invite（5引数）・
--                              list_invites・set_invite_approval・my_join_status・cancel_join_request・
--                              list_join_requests・decide_join_request。中だけ: join_request_notify、
--                              トリガー accounts_join_request_notify。create_community は founder を記録する。
--   * 通知                     notifications_type_check に join_request / join_approved を足す（13 + 2）。
--   * 10/29 の手作業の記録     app_settings の 'removed:<id>' があれば community_removals に移して消す。
--
-- 古いコード（今の main）のまま、この SQL を先に流しても壊れない:
--   * claim_invite: 引数は code だけでも呼べる（consent は default null）。返り値はキーが増えるだけ。
--     今あるリンクは needs_approval = false なので、今までどおりすぐメンバーになる。
--   * create_invite: 古いコードは3つの名前つき引数で呼ぶ。足した2つは default が効く。
--   * list_invites・check_invite: 列・キーが増えるだけ（古いコードは名前で読む）。
--   * accounts のトリガー: 承認待ちの行が無ければ何もしない。失敗しても accounts の保存を止めない。
--   * 通知の種類の制約: 今ある13種類を残して足すだけ。
--   例外: 外された人（今はカンベさんだけ）が古い画面のままリンクを開くと、承認待ちになる（A の 3 章の例外1）。
--
-- 足す・作り直すだけで、何度流しても壊れない。1本 = 1 transaction。
-- 戻すときは supabase/rollback/20261101000000_join_approval_rollback.sql（コードを先に戻してから）。
begin;

-- 長く待たない: 他の処理に鍵を取られていたら、3秒で諦めて何も変えずに終わる（55P03 / 40P01 なら少し待ってもう一度流す）。
set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- ===========================================================================
-- 1. 列
-- ===========================================================================
alter table public.community_invites
  add column if not exists needs_approval boolean not null default false,
  add column if not exists post_id uuid references public.posts (id) on delete set null;

-- joined_via: 列を足した瞬間の1回だけ、今ある行を埋める（2回目以降に流しても、あとで管理者になった人を
-- founder に書き換えない）。
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'community_members' and column_name = 'joined_via') then
    alter table public.community_members
      add column joined_via text not null default 'invite'
        check (joined_via in ('founder', 'invite', 'approval', 'event'));
    update public.community_members set joined_via = 'founder' where role = 'admin';
  end if;
end $$;

alter table public.community_members
  add column if not exists invite_id uuid references public.community_invites (id) on delete set null,
  add column if not exists event_post_id uuid references public.posts (id) on delete set null;

-- ===========================================================================
-- 2. 表
-- ===========================================================================
-- account_id は auth.users を指す: 新しい人は accounts の行がまだ無いまま申し込めるため。
create table if not exists public.community_join_requests (
  community_id    uuid not null references public.communities (id) on delete cascade,
  account_id      uuid not null references auth.users (id) on delete cascade,
  invite_id       uuid references public.community_invites (id) on delete set null,
  status          text not null default 'pending' check (status in ('pending', 'rejected')),
  was_removed     boolean not null default false,
  rejected_before boolean not null default false,
  requested_at    timestamptz not null default now(),
  notified_at     timestamptz,
  decided_at      timestamptz,
  decided_by      uuid references auth.users (id) on delete set null,
  consent_version text,
  primary key (community_id, account_id)
);
create index if not exists community_join_requests_account_idx
  on public.community_join_requests (account_id);
create index if not exists community_join_requests_pending_idx
  on public.community_join_requests (community_id, requested_at) where status = 'pending';

create table if not exists public.community_removals (
  community_id       uuid not null references public.communities (id) on delete cascade,
  account_id         uuid not null references auth.users (id) on delete cascade,
  removed_at         timestamptz not null default now(),
  removed_by         uuid references auth.users (id) on delete set null,
  joined_at_before   timestamptz not null default now(),
  hidden_post_ids    uuid[] not null default '{}',
  hidden_comment_ids uuid[] not null default '{}',
  primary key (community_id, account_id)
);
create index if not exists community_removals_account_idx on public.community_removals (account_id);

-- 管理者への通知の間引き用。通知の行とは別に「最後に知らせた時刻」を覚える（取り消して申し込み直しても、
-- 24時間に1回まで）。承認・断る・オフのリンクで入ったときに、その行を消す。
create table if not exists public.join_request_notices (
  community_id uuid not null references public.communities (id) on delete cascade,
  account_id   uuid not null references auth.users (id) on delete cascade,
  notified_at  timestamptz not null default now(),
  primary key (community_id, account_id)
);

-- 3つとも invite_claims と同じ形: 全拒否。サーバーのキー(service_role)は RLS を通らない。
alter table public.community_join_requests enable row level security;
alter table public.community_removals      enable row level security;
alter table public.join_request_notices    enable row level security;
revoke all on public.community_join_requests, public.community_removals, public.join_request_notices from anon, authenticated;
grant all on public.community_join_requests, public.community_removals, public.join_request_notices to service_role;
drop policy if exists join_request_notices_none on public.join_request_notices;
create policy join_request_notices_none on public.join_request_notices
  for all using (false) with check (false);
drop policy if exists community_join_requests_none on public.community_join_requests;
drop policy if exists community_removals_none      on public.community_removals;
create policy community_join_requests_none on public.community_join_requests
  for all using (false) with check (false);
create policy community_removals_none on public.community_removals
  for all using (false) with check (false);

-- ===========================================================================
-- 3. 通知の種類（今の13種類を全部残して、2つ足す）
-- ===========================================================================
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('like', 'help', 'join', 'comment', 'reply', 'connection', 'similar', 'island',
                  'quiet_post', 'talk_wish', 'talk_match', 'dm', 'match',
                  'join_request', 'join_approved'));

-- ===========================================================================
-- 4. 中だけの関数（誰にも実行権を渡さない）
-- ===========================================================================
-- 管理者全員に「参加を待っています」（join_request）を書く。payload は {community_id, community_name} だけ
-- （メールアドレスは入れない）。間引き: join_request_notices に、同じ人・同じ会で24時間以内に知らせた記録があれば
-- 書かない（取り消しても記録は消えないので、取り消して申し込み直しても24時間に1回）。書くときは、古い同じ通知を
-- 消してから書く。申し込んだ人の accounts の行が無ければ何もしない（notifications.actor_id は accounts を指すため。
-- 名前を入れたとき、トリガーが呼び直す）。
create or replace function public.join_request_notify(community uuid, person uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  cname text;
begin
  select c.name into cname from public.communities c where c.id = join_request_notify.community;
  if cname is null
     or not exists (select 1 from public.accounts a where a.id = join_request_notify.person) then
    return;
  end if;
  if exists (select 1 from public.join_request_notices s
              where s.community_id = join_request_notify.community and s.account_id = join_request_notify.person
                and s.notified_at > now() - interval '24 hours') then
    return;
  end if;
  insert into public.join_request_notices (community_id, account_id, notified_at)
  values (join_request_notify.community, join_request_notify.person, now())
  on conflict (community_id, account_id) do update set notified_at = excluded.notified_at;
  delete from public.notifications n
   where n.type = 'join_request' and n.actor_id = join_request_notify.person
     and n.community_id = join_request_notify.community;
  insert into public.notifications (recipient_id, actor_id, type, community_id, payload)
  select m.account_id, join_request_notify.person, 'join_request', join_request_notify.community,
         jsonb_build_object('community_id', join_request_notify.community, 'community_name', cname)
    from public.community_members m
    join public.accounts a on a.id = m.account_id
   where m.community_id = join_request_notify.community
     and m.role = 'admin'
     and m.account_id <> join_request_notify.person;
end $$;
revoke all on function public.join_request_notify(uuid, uuid) from public, anon, authenticated;

-- 名前（accounts の行）ができた・変わったとき、まだ通知していない承認待ちを管理者に知らせる。
-- 中身は begin … exception … end で包む: 通知で何が失敗しても、プロフィールの保存（＝登録）は止めない。
create or replace function public.accounts_join_request_notify()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r record;
begin
  begin
    for r in select q.community_id from public.community_join_requests q
              where q.account_id = new.id and q.status = 'pending' and q.notified_at is null
                for update loop
      perform public.join_request_notify(r.community_id, new.id);
      update public.community_join_requests
         set notified_at = now()
       where community_id = r.community_id and account_id = new.id;
    end loop;
  exception when others then
    raise warning 'accounts_join_request_notify: %', sqlerrm;
  end;
  return new;
end $$;
revoke all on function public.accounts_join_request_notify() from public, anon, authenticated;

drop trigger if exists accounts_join_request_notify on public.accounts;
create trigger accounts_join_request_notify
  after insert or update of display_name on public.accounts
  for each row when (new.display_name is not null)
  execute function public.accounts_join_request_notify();

-- ===========================================================================
-- 5. 招待まわりの関数（ブラウザが呼ぶ）
-- ===========================================================================
-- 招待が使えるか。{"valid", "community_name", "reason", "needs_approval", "post_id"} の5つだけを返す。
-- needs_approval が true になるのは、リンクがオン、またはログイン中の人がその会から外された・断られた人のとき。
-- 無効なリンクでは needs_approval・post_id は null。anon も呼べる。
create or replace function public.check_invite(code text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  inv_comm     uuid;
  inv_expires  timestamptz;
  inv_revoked  timestamptz;
  inv_approval boolean;
  inv_post     uuid;
  cname        text;
  me           uuid := auth.uid();
  approval     boolean;
begin
  select i.community_id, i.expires_at, i.revoked_at, i.needs_approval, i.post_id, c.name
    into inv_comm, inv_expires, inv_revoked, inv_approval, inv_post, cname
    from public.community_invites i
    join public.communities c on c.id = i.community_id
   where i.code = check_invite.code;
  if not found then
    return jsonb_build_object('valid', false, 'community_name', null, 'reason', 'unknown',
                              'needs_approval', null, 'post_id', null);
  end if;
  if inv_revoked is not null then
    return jsonb_build_object('valid', false, 'community_name', cname, 'reason', 'revoked',
                              'needs_approval', null, 'post_id', null);
  end if;
  if inv_expires <= now() then
    return jsonb_build_object('valid', false, 'community_name', cname, 'reason', 'expired',
                              'needs_approval', null, 'post_id', null);
  end if;
  approval := inv_approval
    or (me is not null and (
          exists (select 1 from public.community_removals x
                   where x.community_id = inv_comm and x.account_id = me)
       or exists (select 1 from public.community_join_requests q
                   where q.community_id = inv_comm and q.account_id = me and q.status = 'rejected')));
  return jsonb_build_object('valid', true, 'community_name', cname, 'reason', null,
                            'needs_approval', approval, 'post_id', inv_post);
end $$;

-- 招待を使う。古い1引数の形は消して、(code, consent) の1つだけにする。
-- consent は同意した規約の版（承認待ちになるとき community_join_requests.consent_version に記録）。
-- 返り値 {"community_id", "community_name", "status", "post_id"}。
--   status: joined（入れた）／already（元からメンバー）／pending（承認待ち）
--   post_id: そのリンクに保存された会だけ（URL の ?post= は信用しない）
-- 入れ方:
--   ① すでにメンバー → already（承認待ちの行が残っていれば、行と管理者への通知を消す）
--   ② リンクがオン、または外した人・断った人 → 承認待ち（rejected から戻すときは rejected_before を付ける）
--   ③ それ以外 → メンバーにする（joined_via = 'invite'）。残っていた承認待ちの行と通知を消す
-- uses は、新しく入ったか、新しく承認待ちになったときだけ1増やす。
drop function if exists public.claim_invite(text);
create or replace function public.claim_invite(code text, consent text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me           uuid := auth.uid();
  inv_id       uuid;
  inv_comm     uuid;
  inv_expires  timestamptz;
  inv_revoked  timestamptz;
  inv_approval boolean;
  inv_post     uuid;
  cname        text;
  req_status   text;
  was_rem      boolean;
  added        integer := 0;
  became_pend  boolean := false;
  result       text;
begin
  if me is null then
    raise exception 'ログインしてください。';
  end if;
  select i.id, i.community_id, i.expires_at, i.revoked_at, i.needs_approval, i.post_id, c.name
    into inv_id, inv_comm, inv_expires, inv_revoked, inv_approval, inv_post, cname
    from public.community_invites i
    join public.communities c on c.id = i.community_id
   where i.code = claim_invite.code
     for update of i;
  if not found then
    raise exception '招待リンクが見つかりません。管理者に新しいリンクをもらってください。';
  end if;
  if inv_revoked is not null then
    raise exception '招待リンクは止められています。管理者に新しいリンクをもらってください。';
  end if;
  if inv_expires <= now() then
    raise exception '招待リンクの期限が切れています。管理者に新しいリンクをもらってください。';
  end if;

  if exists (select 1 from public.community_members m
              where m.community_id = inv_comm and m.account_id = me) then
    result := 'already';
    delete from public.community_join_requests q
     where q.community_id = inv_comm and q.account_id = me and q.status = 'pending';
    delete from public.notifications n
     where n.type = 'join_request' and n.actor_id = me and n.community_id = inv_comm;
    delete from public.join_request_notices s where s.community_id = inv_comm and s.account_id = me;
  else
    select q.status into req_status from public.community_join_requests q
     where q.community_id = inv_comm and q.account_id = me;
    was_rem := exists (select 1 from public.community_removals x
                        where x.community_id = inv_comm and x.account_id = me);
    if inv_approval or was_rem or req_status = 'rejected' then
      result := 'pending';
      if req_status is null then
        insert into public.community_join_requests
          (community_id, account_id, invite_id, status, was_removed, consent_version)
        values (inv_comm, me, inv_id, 'pending', was_rem, nullif(left(btrim(consent), 32), ''));
        became_pend := true;
      elsif req_status = 'rejected' then
        update public.community_join_requests
           set status = 'pending', invite_id = inv_id, was_removed = was_rem, rejected_before = true,
               requested_at = now(), notified_at = null, decided_at = null, decided_by = null,
               consent_version = coalesce(nullif(left(btrim(consent), 32), ''), consent_version)
         where community_id = inv_comm and account_id = me;
        became_pend := true;
      end if;
    else
      result := 'joined';
      insert into public.community_members (community_id, account_id, role, joined_via, invite_id)
      values (inv_comm, me, 'member', 'invite', inv_id)
      on conflict (community_id, account_id) do nothing;
      get diagnostics added = row_count;
      delete from public.community_join_requests q
       where q.community_id = inv_comm and q.account_id = me and q.status = 'pending';
      delete from public.notifications n
       where n.type = 'join_request' and n.actor_id = me and n.community_id = inv_comm;
      delete from public.join_request_notices s where s.community_id = inv_comm and s.account_id = me;
    end if;
  end if;

  insert into public.invite_claims (account_id, invite_id) values (me, inv_id)
  on conflict (account_id) do nothing;
  if added > 0 or became_pend then
    update public.community_invites set uses = uses + 1 where id = inv_id;
  end if;
  -- 名前のあるアカウントがすでにあれば、その場で管理者に知らせる（無ければ、名前を入れたときトリガーが知らせる）。
  if became_pend and exists (select 1 from public.accounts a where a.id = me) then
    perform public.join_request_notify(inv_comm, me);
    update public.community_join_requests set notified_at = now()
     where community_id = inv_comm and account_id = me;
  end if;
  return jsonb_build_object('community_id', inv_comm, 'community_name', cname,
                            'status', result, 'post_id', inv_post);
end $$;

-- 招待リンクを作る。古い3引数の形は消して、5引数の1つだけにする（2つ残ると PostgREST がどちらか選べない）。
-- needs_approval: 承認のスイッチ（既定はオフ）。post: 会の投稿（その community の生きている投稿だけ）。
-- 返り値 {"code", "expires_at", "id", "needs_approval", "post_id"}。
drop function if exists public.create_invite(uuid, integer, boolean);
create or replace function public.create_invite(
  community uuid, minutes integer, until_end_of_day boolean default false,
  needs_approval boolean default false, post uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me        uuid := auth.uid();
  expires   timestamptz;
  new_id    uuid;
  new_code  text;
  approval  boolean := coalesce(create_invite.needs_approval, false);
  -- 日本時間の今日の終わり(23:59)。+9時間で出す（夏時間が無い）。UTC の時刻に戻す。
  day_end   timestamptz := ((date_trunc('day', (now() at time zone 'UTC') + interval '9 hours')
                              + interval '1 day' - interval '1 minute') - interval '9 hours') at time zone 'UTC';
begin
  if me is null then
    raise exception 'ログインしてください。';
  end if;
  if community is null or not public.is_community_admin(community) then
    raise exception 'このコミュニティの招待リンクは、管理者だけが作れます。';
  end if;
  if create_invite.post is not null and not exists (
       select 1 from public.posts p
        where p.id = create_invite.post and p.community_id = create_invite.community and p.deleted_at is null) then
    raise exception 'この投稿はこのコミュニティのものではありません。';
  end if;
  if coalesce(until_end_of_day, false) then
    expires := day_end;
    if expires < now() + interval '10 minutes' then
      expires := expires + interval '1 day';
    end if;
  else
    if minutes is null or minutes < 1 or minutes > 43200 then
      raise exception '有効な時間は1分から30日の間で指定してください。';
    end if;
    expires := now() + make_interval(mins => minutes);
  end if;
  new_code := public.make_invite_code();
  insert into public.community_invites (community_id, code, created_by, expires_at, needs_approval, post_id)
  values (community, new_code, me, expires, approval, create_invite.post)
  returning id into new_id;
  return jsonb_build_object('code', new_code, 'expires_at', expires, 'id', new_id,
                            'needs_approval', approval, 'post_id', create_invite.post);
end $$;

-- 招待の一覧（新しい順、最大100件）。返す列が変わるので、消して作り直す。
drop function if exists public.list_invites(uuid);
create or replace function public.list_invites(community uuid)
returns table (id uuid, code text, expires_at timestamptz, revoked_at timestamptz,
               uses integer, created_at timestamptz, needs_approval boolean, post_id uuid)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'ログインしてください。';
  end if;
  if community is null or not public.is_community_admin(community) then
    raise exception 'このコミュニティの招待リンクは、管理者だけが見られます。';
  end if;
  return query
    select i.id, i.code, i.expires_at, i.revoked_at, i.uses, i.created_at, i.needs_approval, i.post_id
      from public.community_invites i
     where i.community_id = list_invites.community
     order by i.created_at desc
     limit 100;
end $$;

-- 承認のスイッチ。管理者だけ。オンにするときは、その会の使えるリンクを全部オンにする（画面は新しい1本しか
-- 見せないので、古いオフのリンクが残る穴を防ぐ）。オフは、そのリンクだけ。すでに承認待ちの人はそのまま。
-- 引数名は approval（on は SQL の予約語）。
create or replace function public.set_invite_approval(invite uuid, approval boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare
  inv_comm uuid;
begin
  if auth.uid() is null then
    raise exception 'ログインしてください。';
  end if;
  select i.community_id into inv_comm from public.community_invites i where i.id = invite;
  if not found or not public.is_community_admin(inv_comm) then
    raise exception 'この招待リンクは、管理者だけが変えられます。';
  end if;
  if coalesce(approval, false) then
    update public.community_invites i set needs_approval = true
     where i.community_id = inv_comm
       and (i.id = invite or (i.revoked_at is null and i.expires_at > now()));
  else
    update public.community_invites i set needs_approval = false where i.id = invite;
  end if;
end $$;

-- ===========================================================================
-- 6. 承認待ちの本人・管理者が呼ぶ関数
-- ===========================================================================
-- 自分の状態。status: pending（承認待ち）／rejected（断られた）／removed（外された。待ちも断られたも無いときだけ）。
create or replace function public.my_join_status()
returns table (community_id uuid, community_name text, status text, at timestamptz)
language sql stable security definer set search_path = public as $$
  select q.community_id, c.name, q.status,
         case when q.status = 'rejected' then coalesce(q.decided_at, q.requested_at) else q.requested_at end
    from public.community_join_requests q
    join public.communities c on c.id = q.community_id
   where q.account_id = auth.uid()
  union all
  select x.community_id, c.name, 'removed', x.removed_at
    from public.community_removals x
    join public.communities c on c.id = x.community_id
   where x.account_id = auth.uid()
     and not exists (select 1 from public.community_join_requests q
                      where q.community_id = x.community_id and q.account_id = x.account_id)
  order by 4 desc, 1
$$;

-- 自分の承認待ちを取り消す（行を消し、管理者への通知も消す。join_request_notices は消さない＝申し込み直しても24時間は知らせない）。ただし、前に断られたことがある人
-- （rejected_before）の行は消さず、断られた状態に戻す（消すと、取り消しで断りを帳消しにして、
-- オフのリンクで入り直せてしまう）。断られた行そのものは触らない。
create or replace function public.cancel_join_request(community uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'ログインしてください。';
  end if;
  update public.community_join_requests q
     set status = 'rejected', decided_at = now(), notified_at = null
   where q.community_id = cancel_join_request.community and q.account_id = me
     and q.status = 'pending' and q.rejected_before;
  delete from public.community_join_requests q
   where q.community_id = cancel_join_request.community and q.account_id = me and q.status = 'pending';
  delete from public.notifications n
   where n.type = 'join_request' and n.actor_id = me and n.community_id = cancel_join_request.community;
end $$;

-- 承認待ちの一覧（管理者だけ）。名前のあるアカウントを持つ pending の人だけ。メールアドレスとログイン方法は
-- ここでだけ出す。承認・お断りのあとは行が pending でなくなるので、取り出せない（E の 10）。
create or replace function public.list_join_requests(community uuid)
returns table (account_id uuid, display_name text, affiliation text, icon_id text, avatar_path text,
               email text, provider text, requested_at timestamptz,
               was_removed boolean, rejected_before boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'ログインしてください。';
  end if;
  if community is null or not public.is_community_admin(community) then
    raise exception 'このコミュニティの承認待ちは、管理者だけが見られます。';
  end if;
  return query
    select q.account_id, a.display_name, a.affiliation, a.icon_id, a.avatar_path,
           u.email::text, (u.raw_app_meta_data ->> 'provider')::text, q.requested_at,
           q.was_removed, q.rejected_before
      from public.community_join_requests q
      join public.accounts a on a.id = q.account_id
      join auth.users u on u.id = q.account_id
     where q.community_id = list_join_requests.community and q.status = 'pending'
     order by q.requested_at, q.account_id;
end $$;

-- 承認する／断る（管理者だけ）。返り値 'approved' / 'rejected' / 'already'（もう決まっていた）。
-- 申し込みの行は for update で読む（2人の管理者が同時に押しても、後の人は 'already'）。
--   承認: メンバーに入れる（joined_via = 'approval'）。前に外した人なら、前の入った日時のまま入れ、隠した投稿・
--         コメントも戻す（「ほかのコミュニティにも出す」の一意の索引とぶつかる投稿は飛ばす）。申し込みの行は消す。
--         その人の accounts の行があるときだけ join_approved を送る。
--   断る: rejected にする（行は残す。次にどのリンクを使っても承認待ちに戻る）。
--   どちらでも、その人の join_request 通知は全部消す。
create or replace function public.decide_join_request(community uuid, person uuid, approve boolean)
returns text
language plpgsql security definer set search_path = public as $$
declare
  me        uuid := auth.uid();
  req       public.community_join_requests%rowtype;
  rem       public.community_removals%rowtype;
  cname     text;
  pid       uuid;
begin
  if me is null then
    raise exception 'ログインしてください。';
  end if;
  if community is null or not public.is_community_admin(community) then
    raise exception 'このコミュニティの承認は、管理者だけが行えます。';
  end if;
  select q.* into req from public.community_join_requests q
   where q.community_id = decide_join_request.community and q.account_id = decide_join_request.person
     for update;
  if not found or req.status <> 'pending' then
    return 'already';
  end if;
  select c.name into cname from public.communities c where c.id = decide_join_request.community;

  if coalesce(approve, false) then
    select x.* into rem from public.community_removals x
     where x.community_id = decide_join_request.community and x.account_id = decide_join_request.person;
    insert into public.community_members (community_id, account_id, role, joined_at, joined_via, invite_id)
    values (decide_join_request.community, decide_join_request.person, 'member',
            coalesce(rem.joined_at_before, now()), 'approval', req.invite_id)
    on conflict (community_id, account_id) do nothing;
    if found and rem.account_id is not null then
      foreach pid in array rem.hidden_post_ids loop
        begin
          update public.posts p set deleted_at = null
           where p.id = pid and p.community_id = decide_join_request.community and p.deleted_at is not null;
        exception when unique_violation then
          null;
        end;
      end loop;
      update public.comments k set deleted_at = null
       where k.id = any (rem.hidden_comment_ids) and k.deleted_at is not null;
    end if;
    delete from public.community_removals x
     where x.community_id = decide_join_request.community and x.account_id = decide_join_request.person;
    delete from public.community_join_requests q
     where q.community_id = decide_join_request.community and q.account_id = decide_join_request.person;
    if exists (select 1 from public.accounts a where a.id = decide_join_request.person) then
      insert into public.notifications (recipient_id, actor_id, type, community_id, payload)
      values (decide_join_request.person, me, 'join_approved', decide_join_request.community,
              jsonb_build_object('community_id', decide_join_request.community, 'community_name', cname));
    end if;
  else
    update public.community_join_requests q
       set status = 'rejected', decided_at = now(), decided_by = me
     where q.community_id = decide_join_request.community and q.account_id = decide_join_request.person;
  end if;
  delete from public.notifications n
   where n.type = 'join_request' and n.actor_id = decide_join_request.person
     and n.community_id = decide_join_request.community;
  -- 決まったので、間引きの記録も消す（断られたあとの申し込みは、また知らせる）
  delete from public.join_request_notices s
   where s.community_id = decide_join_request.community and s.account_id = decide_join_request.person;
  return case when coalesce(approve, false) then 'approved' else 'rejected' end;
end $$;

-- ===========================================================================
-- 7. 運営用: コミュニティを作る関数に founder の記録を足す（権限は今のまま service_role だけ）
-- ===========================================================================
create or replace function public.create_community(community_name text, community_slug text, admin_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  new_id uuid;
begin
  -- 同じスラッグの会がすでにあれば、それを使う（運営の塊を2回流しても壊れない）。
  select c.id into new_id from public.communities c where c.slug = community_slug;
  if new_id is null then
    insert into public.communities (name, slug, created_by)
    values (community_name, community_slug, admin_id)
    returning id into new_id;
  end if;
  insert into public.community_members (community_id, account_id, role, joined_via)
  values (new_id, admin_id, 'admin', 'founder')
  on conflict (community_id, account_id) do update set role = 'admin';
  return new_id;
end $$;

-- ===========================================================================
-- 8. 権限（必ず先に revoke。Supabase は新しい関数に全員の実行権を自動で付けるため）
-- ===========================================================================
revoke all on function public.check_invite(text)                                   from public;
revoke all on function public.claim_invite(text, text)                             from public, anon;
revoke all on function public.create_invite(uuid, integer, boolean, boolean, uuid) from public, anon;
revoke all on function public.list_invites(uuid)                                   from public, anon;
revoke all on function public.set_invite_approval(uuid, boolean)                   from public, anon;
revoke all on function public.my_join_status()                                     from public, anon;
revoke all on function public.cancel_join_request(uuid)                            from public, anon;
revoke all on function public.list_join_requests(uuid)                             from public, anon;
revoke all on function public.decide_join_request(uuid, uuid, boolean)             from public, anon;
revoke all on function public.create_community(text, text, uuid)                   from public, anon, authenticated;
grant execute on function public.check_invite(text)                                   to anon, authenticated;
grant execute on function public.claim_invite(text, text)                             to authenticated;
grant execute on function public.create_invite(uuid, integer, boolean, boolean, uuid) to authenticated;
grant execute on function public.list_invites(uuid)                                   to authenticated;
grant execute on function public.set_invite_approval(uuid, boolean)                   to authenticated;
grant execute on function public.my_join_status()                                     to authenticated;
grant execute on function public.cancel_join_request(uuid)                            to authenticated;
grant execute on function public.list_join_requests(uuid)                             to authenticated;
grant execute on function public.decide_join_request(uuid, uuid, boolean)             to authenticated;
grant execute on function public.create_community(text, text, uuid)                   to service_role;

-- ===========================================================================
-- 9. 10/29 の手作業の記録（app_settings の 'removed:<id>'）を community_removals に移す
-- ===========================================================================
-- 行が無ければ何もしない。移したら、その行を消す（2回流しても増えない）。
-- 隠した id は、deleted_at = その時刻 と、投稿の会で分けて求める（別の会のコピー・ほかの会のコメントは含めない）。
-- すでにその会のメンバーに戻っている人は、移さない（メンバーなのに「外した人」の記録が残るのを防ぐ）。
-- 移したあとは「本番SQL_カンベさんを外す_20261029」の 3_戻す.sql は使えない（画面の「戻す」を使う）。
do $$
declare
  s      record;
  kid    uuid;
  at_ts  timestamptz;
  c      jsonb;
  cid    uuid;
  pids   uuid[];
  cids   uuid[];
begin
  for s in select a.key, a.value from public.app_settings a where a.key like 'removed:%' loop
    begin
      kid   := substr(s.key, 9)::uuid;
      at_ts := (s.value ->> 'at')::timestamptz;
    exception when others then
      continue;   -- 形が違う行は、触らずに残す
    end;
    if exists (select 1 from auth.users u where u.id = kid) then
      for c in select e from jsonb_array_elements(coalesce(s.value -> 'communities', '[]'::jsonb)) e loop
        cid := (c ->> 'community_id')::uuid;
        if exists (select 1 from public.communities m where m.id = cid)
           and not exists (select 1 from public.community_members cm
                            where cm.community_id = cid and cm.account_id = kid) then
          select coalesce(array_agg(p.id), '{}') into pids from public.posts p
           where p.author_id = kid and p.community_id = cid and p.deleted_at = at_ts;
          select coalesce(array_agg(k.id), '{}') into cids
            from public.comments k join public.posts p on p.id = k.post_id
           where k.author_id = kid and p.community_id = cid and k.deleted_at = at_ts;
          insert into public.community_removals
            (community_id, account_id, removed_at, removed_by, joined_at_before, hidden_post_ids, hidden_comment_ids)
          values (cid, kid, at_ts, null, coalesce((c ->> 'joined_at')::timestamptz, at_ts), pids, cids)
          on conflict (community_id, account_id) do nothing;
        end if;
      end loop;
    end if;
    delete from public.app_settings where key = s.key;
  end loop;
end $$;

commit;
