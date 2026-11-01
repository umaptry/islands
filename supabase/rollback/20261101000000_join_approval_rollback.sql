-- 戻し用: 20261101000000_join_approval.sql（承認制・入り方の記録・招待に会を付ける）を取り消す。
--
-- **supabase/migrations の外に置いている**（CLI は migrations の中のファイルを全部流してしまうため）。
-- 本番では Supabase の SQL エディタで、必要なときだけ流す。**コードを先に戻してから**流す
-- （新しいコードが消えた関数を呼ぶと、承認の画面が出なくなる）。
--
-- 戻すもの: 承認制の関数とトリガーを消す。check_invite・claim_invite(code)・create_invite（3引数）・
-- list_invites・create_community を M1 の前の定義に戻す。
-- 戻さないもの（足しただけで無害なので残す）:
--   * 表 community_join_requests / community_removals / join_request_notices（中身も残る）
--   * 列 community_invites.needs_approval / post_id、community_members.joined_via / invite_id / event_post_id
--   * notifications_type_check の join_request / join_approved（今ある通知の行が残っていても壊れない）
--   * M1 が community_removals に移した 10/29 の手作業の記録（app_settings の行は戻さない）
--
-- **「承認待ちの人を全員メンバーにする塊」は付けていない**（確かめていない人や、外した人をまとめて入れてしまうため）。
-- 戻したあと、承認待ちの人は招待リンクをもう一度使うとメンバーになる（古い claim_invite は承認を見ない）。
-- 外した人（community_removals にいる人）も、古い claim_invite では同じリンクでまた入れる。外したままにしたい
-- 人がいるときは、戻す前にこの2つで確かめる:
--   承認待ち:   select r.community_id, r.account_id, a.display_name, r.status, r.requested_at
--                 from public.community_join_requests r left join public.accounts a on a.id = r.account_id
--                where r.status = 'pending' order by r.requested_at;
--   外した人:   select x.community_id, x.account_id, a.display_name, x.removed_at
--                 from public.community_removals x left join public.accounts a on a.id = x.account_id;
-- 1人ずつ入れるときの1行（確かめたうえで）:
--   insert into public.community_members (community_id, account_id, role, joined_via)
--   values ('<コミュニティ id>', '<アカウント id>', 'member', 'approval') on conflict do nothing;
--
-- 何度流しても壊れない。
begin;
set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- 1. 承認制の関数とトリガーを消す
drop trigger if exists accounts_join_request_notify on public.accounts;
drop function if exists public.accounts_join_request_notify();
drop function if exists public.join_request_notify(uuid, uuid);
drop function if exists public.decide_join_request(uuid, uuid, boolean);
drop function if exists public.list_join_requests(uuid);
drop function if exists public.cancel_join_request(uuid);
drop function if exists public.my_join_status();
drop function if exists public.set_invite_approval(uuid, boolean);

-- 2. 招待の関数を前の定義に戻す（20261026010000_communities_and_invites.sql と同じ）
drop function if exists public.claim_invite(text, text);
drop function if exists public.create_invite(uuid, integer, boolean, boolean, uuid);
drop function if exists public.list_invites(uuid);

create or replace function public.check_invite(code text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  inv_expires timestamptz;
  inv_revoked timestamptz;
  cname       text;
begin
  select i.expires_at, i.revoked_at, c.name
    into inv_expires, inv_revoked, cname
    from public.community_invites i
    join public.communities c on c.id = i.community_id
   where i.code = check_invite.code;
  if not found then
    return jsonb_build_object('valid', false, 'community_name', null, 'reason', 'unknown');
  end if;
  if inv_revoked is not null then
    return jsonb_build_object('valid', false, 'community_name', cname, 'reason', 'revoked');
  end if;
  if inv_expires <= now() then
    return jsonb_build_object('valid', false, 'community_name', cname, 'reason', 'expired');
  end if;
  return jsonb_build_object('valid', true, 'community_name', cname, 'reason', null);
end $$;

create or replace function public.claim_invite(code text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me          uuid := auth.uid();
  inv_id      uuid;
  inv_comm    uuid;
  inv_expires timestamptz;
  inv_revoked timestamptz;
  cname       text;
  added       integer;
begin
  if me is null then
    raise exception 'ログインしてください。';
  end if;
  select i.id, i.community_id, i.expires_at, i.revoked_at, c.name
    into inv_id, inv_comm, inv_expires, inv_revoked, cname
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

  insert into public.community_members (community_id, account_id, role)
  values (inv_comm, me, 'member')
  on conflict (community_id, account_id) do nothing;
  get diagnostics added = row_count;
  insert into public.invite_claims (account_id, invite_id) values (me, inv_id)
  on conflict (account_id) do nothing;
  if added > 0 then
    update public.community_invites set uses = uses + 1 where id = inv_id;
  end if;
  return jsonb_build_object('community_id', inv_comm, 'community_name', cname);
end $$;

create or replace function public.create_invite(
  community uuid, minutes integer, until_end_of_day boolean default false
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me        uuid := auth.uid();
  expires   timestamptz;
  new_id    uuid;
  new_code  text;
  day_end   timestamptz := ((date_trunc('day', (now() at time zone 'UTC') + interval '9 hours')
                              + interval '1 day' - interval '1 minute') - interval '9 hours') at time zone 'UTC';
begin
  if me is null then
    raise exception 'ログインしてください。';
  end if;
  if community is null or not public.is_community_admin(community) then
    raise exception 'このコミュニティの招待リンクは、管理者だけが作れます。';
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
  insert into public.community_invites (community_id, code, created_by, expires_at)
  values (community, new_code, me, expires)
  returning id into new_id;
  return jsonb_build_object('code', new_code, 'expires_at', expires, 'id', new_id);
end $$;

create or replace function public.list_invites(community uuid)
returns table (id uuid, code text, expires_at timestamptz, revoked_at timestamptz,
               uses integer, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'ログインしてください。';
  end if;
  if community is null or not public.is_community_admin(community) then
    raise exception 'このコミュニティの招待リンクは、管理者だけが見られます。';
  end if;
  return query
    select i.id, i.code, i.expires_at, i.revoked_at, i.uses, i.created_at
      from public.community_invites i
     where i.community_id = list_invites.community
     order by i.created_at desc
     limit 100;
end $$;

create or replace function public.create_community(community_name text, community_slug text, admin_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  new_id uuid;
begin
  select c.id into new_id from public.communities c where c.slug = community_slug;
  if new_id is null then
    insert into public.communities (name, slug, created_by)
    values (community_name, community_slug, admin_id)
    returning id into new_id;
  end if;
  insert into public.community_members (community_id, account_id, role)
  values (new_id, admin_id, 'admin')
  on conflict (community_id, account_id) do update set role = 'admin';
  return new_id;
end $$;

revoke all on function public.check_invite(text)                      from public;
revoke all on function public.claim_invite(text)                      from public, anon;
revoke all on function public.create_invite(uuid, integer, boolean)   from public, anon;
revoke all on function public.list_invites(uuid)                      from public, anon;
revoke all on function public.create_community(text, text, uuid)      from public, anon, authenticated;
grant execute on function public.check_invite(text)                    to anon, authenticated;
grant execute on function public.claim_invite(text)                    to authenticated;
grant execute on function public.create_invite(uuid, integer, boolean) to authenticated;
grant execute on function public.list_invites(uuid)                    to authenticated;
grant execute on function public.create_community(text, text, uuid)   to service_role;

commit;
