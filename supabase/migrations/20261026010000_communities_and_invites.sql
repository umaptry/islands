-- 2026-10-26: コミュニティ、招待 URL（コミュニティ単位・期限つき）、コミュニティごとの地図、招待制の登録。
--
--   * communities        コミュニティ。名前は誰でも読める（招待の画面と地図で出す）。作るのは運営だけ
--                        （SQL エディタで create_community を1行。クライアントには作らせない）。
--   * community_members  誰がどのコミュニティに入っているか。role は 'admin' / 'member'。入るのは関数
--                        （claim_invite / create_community）だけ。読めるのは自分の行と、自分が入っている
--                        コミュニティの行。抜けるのは自分の行の delete だけ。
--   * community_invites  招待。code は推測できない長さ（24字のランダム）。読めるのはそのコミュニティの
--                        管理者だけ。作る・止めるのは関数だけ。
--   * invite_claims      「新しいアカウントを作ってよい」印。全拒否（関数とトリガーだけが触る）。
--   * app_settings       key/value の設定。いまは invite_only だけ。**最初は false**。全拒否。
--   * posts.community_id 投稿がどのコミュニティの地図に出るか。列の追加だけ。今のコードは送らないので null
--                        のまま（null の投稿は、どのコミュニティの地図にも出ない）。
--   * 関数               check_invite / claim_invite / create_invite / list_invites / revoke_invite /
--                        my_communities / community_map_posts / create_community（運営用）。
--   * 招待制の本体       accounts の BEFORE INSERT トリガー accounts_invite_guard。
--                        invite_only が true で、その id の行がまだなく、invite_claims にも無いと止める。
--                        **その id の行がすでにあるときは必ず通す**（merge-duplicates の upsert は、既存
--                        アカウントの更新でも BEFORE INSERT が走る。ここを間違えると今の人のプロフィール保存が
--                        全部壊れる）。サービスキーでも、ブラウザからの直接 insert でも止まる。
--
-- 期限は「招待を使う瞬間（claim_invite）」で確かめる。「今日中」は日本時間のその日の 23:59
-- （夏時間が無いので、時刻表を使わず +9 時間で出す）。残りが10分に満たなければ翌日の 23:59 にする。
--
-- 足すだけの変更で、何度流しても壊れない。**今の本番のコード（main）は、新しい表・列・関数を使わない**ので
-- そのまま動く: posts の select は列を名前で並べているので新しい列は読まないし、insert も列を名前で
-- 書く。invite_only は false で始まるので、今のコードが招待なしで登録しても accounts のトリガーは通す。
--
-- **出す順番（この順番を守る）**: ① この SQL（と、その前の talk_and_dm） → ② コード → ③ 下の「BAR を作る
-- 1つの塊」 → ④ 2分ほど待って「取りこぼしを拾う3文」をもう一度 → ⑤ invite_only を true。
-- 新しいコードは、communities に**1行以上あるとき**だけ features.communities を true にする
-- （core/store.py の communities_ready。最長1分ほどのキャッシュ）。だから ② のあと ③ までは、新しいコードも
-- 今までどおり（全員の地図、招待なしの登録）で動く。③ の塊が終わった時点で、全員が BAR に入り、投稿も BAR に
-- 移っているので、機能が ON になった瞬間から全員が BAR の地図を見られる。（BAR を先に作ってからコードを出すと、
-- コードが出るまでの間に増えた人・投稿が BAR に入らない。③ は必ずコードのあと。）
-- 戻すときはコードだけ戻す（表と関数は残してよい。invite_only が true のまま古いコードに戻すと新規登録が
-- 止まるので、その場合は `update public.app_settings set value = 'false' where key = 'invite_only'` を先に流す）。
--
-- 運営が SQL エディタで使う行:
--   ③ BAR を作る1つの塊（まとめて貼って1回で流す。途中で止まったら全部戻る。何度流しても壊れない）:
--        begin;
--        select public.create_community('BAR', 'bar', '<ユーザーのアカウント id>');
--        insert into public.community_members (community_id, account_id, role)
--          select id, '<もう1人の管理者のアカウント id>', 'admin' from public.communities where slug = 'bar'
--        on conflict (community_id, account_id) do update set role = 'admin';
--        -- 今ある人を全員 BAR に入れる（入れないと「招待リンクから参加してください」と出る）
--        insert into public.community_members (community_id, account_id)
--          select (select id from public.communities where slug = 'bar'), a.id from public.accounts a
--        on conflict do nothing;
--        -- 今ある投稿を BAR の地図に移す（コミュニティの指定が無い投稿は、どの地図にも出ない）
--        update public.posts set community_id = (select id from public.communities where slug = 'bar')
--         where community_id is null;
--        -- 今あるアカウントに「新しいアカウントを作ってよい」印を付ける。招待制にしたあとで、古いアカウントが
--        -- 自分の行を消して作り直そうとしても止まらないように（accounts は自分の行の delete を許している）
--        insert into public.invite_claims (account_id) select id from public.accounts
--        on conflict do nothing;
--        commit;
--   ④ 取りこぼしを拾う3文（② と ③ の間に、古いコードで作られた投稿と人。ON になって2分ほどあとにもう一度）:
--        update public.posts set community_id = (select id from public.communities where slug = 'bar')
--         where community_id is null;
--        insert into public.community_members (community_id, account_id)
--          select (select id from public.communities where slug = 'bar'), a.id from public.accounts a
--        on conflict do nothing;
--        insert into public.invite_claims (account_id) select id from public.accounts
--        on conflict do nothing;
--      （保守モード中は posts の update が 55000 で止まる。保守モードを終えてから流す。この update は
--       posts_touch で全行の updated_at を書き換えるが、件数が少ないので害は小さい）
--   ⑤ 動作を確かめてから、招待制にする（元に戻すときは false）:
--        update public.app_settings set value = 'true' where key = 'invite_only';
--
-- 保守モード（check_map_maintenance）のトリガーは新しい表には付けない（投稿から計算した値を作り直す間の
-- 書き込み止めとは無関係）。
begin;

-- ===========================================================================
-- 1. Tables
-- ===========================================================================
create table if not exists public.communities (
  id         uuid primary key default gen_random_uuid(),
  slug       text unique check (slug is null or slug ~ '^[a-z0-9][a-z0-9-]{0,38}$'),
  name       text not null check (length(name) between 1 and 40),
  created_by uuid references public.accounts (id) on delete set null,
  created_at timestamptz not null default now()
);

-- account_id は auth.users を指す: 新しい人は claim_invite の時点で accounts の行がまだ無いため。
create table if not exists public.community_members (
  community_id uuid not null references public.communities (id) on delete cascade,
  account_id   uuid not null references auth.users (id) on delete cascade,
  role         text not null default 'member' check (role in ('admin', 'member')),
  joined_at    timestamptz not null default now(),
  primary key (community_id, account_id)
);
create index if not exists community_members_account_idx on public.community_members (account_id);

create table if not exists public.community_invites (
  id           uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities (id) on delete cascade,
  code         text not null unique check (length(code) >= 22),
  created_by   uuid references public.accounts (id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  uses         integer not null default 0 check (uses >= 0)
);
create index if not exists community_invites_community_idx on public.community_invites (community_id, created_at desc);

create table if not exists public.invite_claims (
  account_id uuid primary key references auth.users (id) on delete cascade,
  invite_id  uuid references public.community_invites (id) on delete set null,
  claimed_at timestamptz not null default now()
);

create table if not exists public.app_settings (
  key   text primary key,
  value jsonb not null
);
-- 最初は false。今の本番のコードは招待なしで登録するので、コードを出したあとに運営が1行で true にする。
insert into public.app_settings (key, value) values ('invite_only', 'false'::jsonb)
on conflict (key) do nothing;

alter table public.posts
  add column if not exists community_id uuid references public.communities (id) on delete set null;
create index if not exists posts_community_created_idx on public.posts (community_id, created_at);

-- ===========================================================================
-- 2. Inside helpers (used by the policies below)
-- ===========================================================================
-- 自分が入っているコミュニティ。policy の中で community_members 自身を読むと再帰になるので、
-- security definer の関数を通す（自分の分しか返さない）。
create or replace function public.my_community_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select m.community_id from public.community_members m where m.account_id = auth.uid()
$$;

create or replace function public.is_community_admin(community uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.community_members m
                  where m.community_id = community and m.account_id = auth.uid()
                    and m.role = 'admin')
$$;

-- 抜けてよいか。最後の管理者は抜けられない（管理者が0人になると、招待を作る・止める人がいなくなり、
-- SQL エディタでしか直せない）。管理者でない人は、いつでも抜けられる。
create or replace function public.can_leave_community(community uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.community_members m
                      where m.community_id = community and m.account_id = auth.uid() and m.role = 'admin')
      or exists (select 1 from public.community_members m
                  where m.community_id = community and m.role = 'admin' and m.account_id <> auth.uid())
$$;

revoke all on function public.my_community_ids()           from public, anon;
revoke all on function public.can_leave_community(uuid)     from public, anon;
grant execute on function public.can_leave_community(uuid)  to authenticated;
revoke all on function public.is_community_admin(uuid)     from public, anon;
grant execute on function public.my_community_ids()        to authenticated;
grant execute on function public.is_community_admin(uuid)  to authenticated;

-- ===========================================================================
-- 3. Privileges and row level security
-- ===========================================================================
alter table public.communities        enable row level security;
alter table public.community_members enable row level security;
alter table public.community_invites  enable row level security;
alter table public.invite_claims      enable row level security;
alter table public.app_settings       enable row level security;

revoke all on public.communities, public.community_members, public.community_invites,
              public.invite_claims, public.app_settings
  from anon, authenticated;

-- communities: select は誰でも。insert/update/delete はクライアントに許さない（権限も policy も無い）。
drop policy if exists communities_read on public.communities;
create policy communities_read on public.communities for select using (true);
grant select on public.communities to anon, authenticated;
grant all on public.communities to service_role;

-- community_members: 自分の行と、自分が入っているコミュニティの行を読める。抜けるのは自分の行だけ。
-- insert / update は関数だけ（権限も policy も無い）。
drop policy if exists community_members_read   on public.community_members;
drop policy if exists community_members_delete on public.community_members;
create policy community_members_read on public.community_members for select to authenticated
  using (account_id = auth.uid() or community_id in (select public.my_community_ids()));
create policy community_members_delete on public.community_members for delete to authenticated
  using (account_id = auth.uid() and public.can_leave_community(community_id));
grant select, delete on public.community_members to authenticated;
grant all on public.community_members to service_role;

-- community_invites: 読めるのはそのコミュニティの管理者だけ。insert / update は関数だけ。
drop policy if exists community_invites_read on public.community_invites;
create policy community_invites_read on public.community_invites for select to authenticated
  using (public.is_community_admin(community_id));
grant select on public.community_invites to authenticated;
grant all on public.community_invites to service_role;

-- invite_claims / app_settings: 全拒否。サーバーのキー(service_role)は RLS を通らない。
drop policy if exists invite_claims_none on public.invite_claims;
drop policy if exists app_settings_none  on public.app_settings;
create policy invite_claims_none on public.invite_claims for all using (false) with check (false);
create policy app_settings_none  on public.app_settings  for all using (false) with check (false);
grant all on public.invite_claims, public.app_settings to service_role;

-- 画面が直接読む列（投稿を1件読んだとき、どのコミュニティの地図かを決めるため）。書く権限は足さない。
grant select (community_id) on public.posts to anon, authenticated;

-- ===========================================================================
-- 4. Functions (what the browser calls)
-- ===========================================================================
-- 24字のランダムな招待コード。gen_random_uuid() の先頭12字（バージョンの桁より前）を2つ使う
-- （pgcrypto は Supabase では extensions スキーマにあり、search_path に無いので使わない）。
create or replace function public.make_invite_code()
returns text
language sql volatile set search_path = public as $$
  select substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
      || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
$$;
revoke all on function public.make_invite_code() from public, anon, authenticated;

-- 招待が使えるか。{"valid", "community_name", "reason"} だけを返す（コミュニティの id などは返さない）。
-- anon も呼べる。code は24字のランダムなので、当てずっぽうでは見つからない。
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

-- 招待を使う。ログイン中のみ（新しい人は accounts の行がまだ無くてよい）。期限内で止められていなければ、
-- community_members に member で入れ（すでにいれば何もしない）、invite_claims に自分を記録し（なければ）、
-- 新しく入ったときだけ uses を増やす。返り値 {"community_id", "community_name"}。無効なら日本語の例外。
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

-- 招待リンクを作る。そのコミュニティの管理者だけ。minutes は 1〜43200（30日）。
-- until_end_of_day が true のときは minutes を見ず、その日（日本時間）の 23:59 まで。
-- 返り値 {"code", "expires_at", "id"}。
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

-- 招待の一覧（新しい順、最大100件）。そのコミュニティの管理者だけ。
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

-- 招待を止める。そのコミュニティの管理者だけ。止めた時刻は最初の1回を残す。
create or replace function public.revoke_invite(invite uuid)
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
    raise exception 'この招待リンクは、管理者だけが止められます。';
  end if;
  update public.community_invites set revoked_at = coalesce(revoked_at, now()) where id = invite;
end $$;

-- 自分が入っているコミュニティ。
create or replace function public.my_communities()
returns table (community_id uuid, slug text, name text, role text)
language sql stable security definer set search_path = public as $$
  select c.id, c.slug, c.name, m.role
    from public.community_members m
    join public.communities c on c.id = m.community_id
   where m.account_id = auth.uid()
   order by m.joined_at, c.id
$$;

-- そのコミュニティの投稿だけの地図。列は map_posts と同じ（map_posts は変えない）。
-- anon も呼べる（map_posts と同じ公開の扱い。投稿は今のまま公開）。
create or replace function public.community_map_posts(
  community uuid,
  min_x double precision, min_y double precision,
  max_x double precision, max_y double precision,
  limit_n integer default 800
)
returns table (
  id uuid, author_id uuid, display_name text, icon_id text, avatar_path text,
  body text, tags text[], motivation smallint, image_path text,
  x double precision, y double precision, cluster_id smallint,
  like_count integer, help_count integer, join_count integer, comment_count integer,
  energy real, created_at timestamptz,
  prompt text, recruit_deadline date, recruit_capacity integer, recruit_closed text
)
language sql stable security definer set search_path = public as $$
  select p.id, p.author_id, a.display_name, a.icon_id, a.avatar_path,
         p.body, p.tags, p.motivation, p.image_path,
         p.x, p.y, p.cluster_id,
         p.like_count, p.help_count, p.join_count, p.comment_count,
         p.energy, p.created_at,
         p.prompt, p.recruit_deadline, p.recruit_capacity,
         public.post_recruit_closed(p.recruit_deadline, p.recruit_capacity, p.join_count)
    from public.posts p
    join public.accounts a on a.id = p.author_id
   where p.deleted_at is null
     and p.community_id = community_map_posts.community
     and point(p.x, p.y) <@ box(point(min_x, min_y), point(max_x, max_y))
   order by p.energy desc, p.created_at desc
   limit least(greatest(limit_n, 1), 2000);
$$;

-- 運営用: コミュニティを作り、指定したアカウントを管理者にする（SQL エディタで1行。同じスラッグが
-- すでにあればその会を使い、管理者を足すだけ）。
--   select public.create_community('BAR', 'bar', '<管理者にする人のアカウント id>');
-- クライアント（anon / authenticated）には呼ばせない。
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
  insert into public.community_members (community_id, account_id, role)
  values (new_id, admin_id, 'admin')
  on conflict (community_id, account_id) do update set role = 'admin';
  return new_id;
end $$;

revoke all on function public.check_invite(text)                      from public;
revoke all on function public.claim_invite(text)                      from public, anon;
revoke all on function public.create_invite(uuid, integer, boolean)   from public, anon;
revoke all on function public.list_invites(uuid)                      from public, anon;
revoke all on function public.revoke_invite(uuid)                     from public, anon;
revoke all on function public.my_communities()                        from public, anon;
revoke all on function public.community_map_posts(uuid, double precision, double precision,
                                                  double precision, double precision, integer)
  from public;
revoke all on function public.create_community(text, text, uuid)      from public, anon, authenticated;
grant execute on function public.check_invite(text)                    to anon, authenticated;
grant execute on function public.claim_invite(text)                    to authenticated;
grant execute on function public.create_invite(uuid, integer, boolean) to authenticated;
grant execute on function public.list_invites(uuid)                    to authenticated;
grant execute on function public.revoke_invite(uuid)                   to authenticated;
grant execute on function public.my_communities()                      to authenticated;
grant execute on function public.community_map_posts(uuid, double precision, double precision,
                                                     double precision, double precision, integer)
  to anon, authenticated;
grant execute on function public.create_community(text, text, uuid)   to service_role;

-- ===========================================================================
-- 5. 招待制の本体: accounts の BEFORE INSERT トリガー
-- ===========================================================================
-- 1. その id の行がすでにある（今あるアカウントの upsert）→ 必ず通す。
-- 2. invite_only が true でなければ通す（最初は false）。
-- 3. invite_claims に自分がいれば通す。
-- 4. それ以外は日本語の例外で止める（SQLSTATE P0001、hint = 'invite_required'）。
-- security definer: invite_claims / app_settings は誰にも読めない表なので、この関数だけが読む。
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

drop trigger if exists accounts_invite_guard on public.accounts;
create trigger accounts_invite_guard before insert on public.accounts
  for each row execute function public.accounts_invite_guard();

commit;
