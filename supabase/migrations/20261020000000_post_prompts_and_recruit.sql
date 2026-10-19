-- 2026-10-20: 投稿のお題（prompt）と「参加者募集中」の申込期限・先着人数、受付終了。
--
--   * posts.prompt            どのお題で書いたか。null / 'weekly'（今週のお題）/ 'past'（昔がんばってたこと）/
--                             'now'（最近はまってること）/ 'future'（今度やってみたいこと）
--   * posts.recruit_deadline  申込期限（日付）。日本時間のその日の終わりまで受け付ける。
--   * posts.recruit_capacity  先着人数（1〜999）。
--     この2つはタグ「参加者募集中」の投稿だけ。タグが外れた（または最初から無い）行は
--     トリガが null に戻す（タグだけ直接書き換えられても CHECK で失敗させない）。
--   * 受付終了: 期限を過ぎた、または 'join'（参加）の数が先着人数に達した投稿には、新しく
--     'join' を入れられない。画面はこの表へ Supabase に直接 insert するので、DB の BEFORE INSERT
--     トリガで断る。断るときのエラーは message が 'recruit_closed'（期限切れ）または
--     'recruit_full'（先着人数に達した）の例外（SQLSTATE P0001）。PostgREST では HTTP 400、
--     本文 {"code":"P0001","message":"recruit_closed",...} で返る。
--     すでに参加している人の再 insert（重複）は断らない（ignore-duplicates のまま何も起きない）。
--     自分の参加の取り消し（delete）は、いつでもできる。
--   * map_posts() が prompt / recruit_deadline / recruit_capacity / recruit_closed を返す。
--     recruit_closed は null / 'deadline' / 'full'。
--   * ブラウザが posts を直接読む列（column grant）に新しい3列を足す。書く権限は足さない
--     （作成・編集は API 経由）。
--
-- 足すだけの変更で、何度流しても壊れない。古いコードは新しい列を読まない・書かないので、
-- そのまま動く。コードより前でも後でもよい。流すまでは、新しいコードが列の有無を見て
-- features.post_extras=false でこの機能を止め、流すと最長1分ほどで（core/store.py の
-- post_extras_ready のキャッシュが切れた時点で）自動的に有効になる。
begin;

alter table public.posts
  add column if not exists prompt           text,
  add column if not exists recruit_deadline date,
  add column if not exists recruit_capacity integer;

alter table public.posts drop constraint if exists posts_prompt_check;
alter table public.posts add constraint posts_prompt_check
  check (prompt is null or prompt in ('weekly', 'past', 'now', 'future'));

alter table public.posts drop constraint if exists posts_recruit_capacity_check;
alter table public.posts add constraint posts_recruit_capacity_check
  check (recruit_capacity is null or recruit_capacity between 1 and 999);

-- 「参加者募集中」のタグが無い投稿は、期限も人数も持たない。
create or replace function public.posts_recruit_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not ('参加者募集中' = any(new.tags)) then
    new.recruit_deadline := null;
    new.recruit_capacity := null;
  end if;
  return new;
end;
$$;
revoke all on function public.posts_recruit_fields() from public, anon, authenticated;

drop trigger if exists posts_recruit_fields on public.posts;
create trigger posts_recruit_fields
  before insert or update of tags, recruit_deadline, recruit_capacity on public.posts
  for each row execute function public.posts_recruit_fields();

-- 受付が終わっているか。null = 受付中、'deadline' = 期限切れ、'full' = 先着人数に達した。
-- 期限は日本時間のその日の終わりまで（翌日の 0:00 JST から終了）。
create or replace function public.post_recruit_closed(
  deadline date, capacity integer, joins integer
)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when deadline is not null
         and now() >= ((deadline + 1)::timestamp at time zone 'Asia/Tokyo') then 'deadline'
    when capacity is not null and joins >= capacity then 'full'
    else null
  end;
$$;
grant execute on function public.post_recruit_closed(date, integer, integer)
  to anon, authenticated, service_role;

-- 参加（join）の受付終了。security definer: 投稿の行を for update で読み、
-- 同時に押された参加が人数を超えないよう、同じ投稿への参加を一人ずつにする。
create or replace function public.reactions_recruit_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  deadline date;
  capacity integer;
  joins integer;
  closed text;
begin
  if new.kind <> 'join' then
    return new;
  end if;
  -- すでに参加している人の重複 insert は、ここでは断らない。
  if exists (select 1 from public.reactions r
              where r.post_id = new.post_id and r.actor_id = new.actor_id and r.kind = 'join') then
    return new;
  end if;
  select p.recruit_deadline, p.recruit_capacity, p.join_count
    into deadline, capacity, joins
    from public.posts p
   where p.id = new.post_id
     for update;
  if not found then
    return new;
  end if;
  closed := public.post_recruit_closed(deadline, capacity, joins);
  if closed = 'deadline' then
    raise exception 'recruit_closed' using errcode = 'P0001', hint = '申込期限を過ぎています';
  elsif closed = 'full' then
    raise exception 'recruit_full' using errcode = 'P0001', hint = '先着人数に達しています';
  end if;
  return new;
end;
$$;
revoke all on function public.reactions_recruit_guard() from public, anon, authenticated;

drop trigger if exists reactions_recruit_guard on public.reactions;
create trigger reactions_recruit_guard
  before insert on public.reactions
  for each row execute function public.reactions_recruit_guard();

-- 画面が直接読める列。書く権限（update）は足さない。
grant select (prompt, recruit_deadline, recruit_capacity) on public.posts to anon, authenticated;

-- map_posts: 返す列が増えるので、作り直す（戻り値の型は create or replace では変えられない）。
-- 呼び方（引数）は同じ。古い画面コードは増えた列を使わないだけで、そのまま動く。
drop function if exists public.map_posts(double precision, double precision,
                                         double precision, double precision, integer);
create function public.map_posts(
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
     and point(p.x, p.y) <@ box(point(min_x, min_y), point(max_x, max_y))
   order by p.energy desc, p.created_at desc
   limit least(greatest(limit_n, 1), 2000);
$$;

revoke all on function public.map_posts(double precision, double precision,
                                        double precision, double precision, integer)
  from public;
grant execute on function public.map_posts(double precision, double precision,
                                           double precision, double precision, integer)
  to anon, authenticated;

commit;
