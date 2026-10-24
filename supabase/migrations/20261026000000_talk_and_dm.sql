-- 2026-10-26: 会の仲間どうしの「話してみたい」（仮名）と、両思いになった2人だけの DM。
--
--   * 「会」= タグ「参加者募集中」(core/config.py の RECRUIT_TAG) を持ち、削除されていない投稿。
--     「会の仲間」= ある会の投稿者、またはその会に reactions(kind='join') がある人。
--     自分と相手が同じ会の仲間のときだけ、押せる。判定はこのファイルの関数が行う
--     （画面の判定は表示のためだけ）。投稿も参加（join）も今のまま公開で、変えない。
--   * talk_wishes   誰が誰を押したか。クライアントからは一切読めない・書けない（push_config と同じ型）。
--                   Realtime の publication にも入れない。2週間より古い行は press_talk が消す。
--   * dm_rooms      両思いになった2人の部屋。関数だけが作る。読めるのは2人だけ。
--   * dm_messages   部屋のメッセージ。読み書きできるのは2人だけ。ブロックがあると送れない。
--   * dm_blocks     ブロック。自分のブロックだけ読める・足せる・消せる（相手には知らせない）。
--   * talk_stats    日ごとの件数だけ。個人を特定する列を持たない。クライアントからは読めない。
--   * 関数 talk_peers / press_talk / withdraw_talk / my_talk_state / dm_room_list
--     （security definer。anon には execute を与えない。ログインの JWT で呼ぶ）。
--   * notifications に type 'talk_wish'（片思い・名前なし）, 'talk_match'（両思い）, 'dm'（新着）を足す。
--     notification_feed() が新しい type を正しく出す。
--
-- 片思い通知の匿名性（actor_id の扱い）: talk_wish は actor_id = NULL で書く。
--   理由:
--   (a) 「受け取る本人」を actor_id に入れる案は、actor_id を持つ行を「その人の名前つきの通知」と読む
--       全ての場所（notification_feed の actor_id 列、画面の attachActors、core/notifications.py の
--       actors、app.py の push_message の title）で、受け取る本人の名前が出てしまう。実際、
--       プッシュの題は actors[0].display_name をそのまま使う。
--   (b) actor_id を NULL にする案は、列がすでに NULL 可（20261006000000_social_foundation.sql で
--       島の通知のために drop not null 済み）なので表を変えずに済み、今の本番のコードが NULL の actor を
--       すでに扱っている（list_notifications の actor=None、attachActors の actors=[]、push_message の
--       「だれか」、画面の headline の「だれか」）。古いコードや知らない描画が来ても「だれか」と出るだけ。
--   よって (b)。さらに: post_id・comment_id・payload・island_id・event_id も NULL（会の投稿を入れると
--   押せる人が絞れるため）。notification_feed が NULL の actor で「ほか -1人」を返さないよう others を 0 以上にする。
--   talk_wish は人数を数えない: 受け取る人に未読の talk_wish がすでにあれば、2通目は書かない
--   （未読の行の数で押した人数が分からない）。
--
-- 足すだけの変更で、何度流しても壊れない。古いコードは新しい表も関数も type も使わないので、
-- そのまま動く。コードより前でも後でもよい。流すまでは、新しいコードが talk_stats の有無を見て
-- features.talk=false でこの機能を止め、流すと最長1分ほどで自動的に有効になる
-- （core/store.py の talk_ready のキャッシュが切れた時点）。戻すときはコードだけ戻す
-- （表と関数は残してよい。誰も呼ばなければ何も起きない）。
--
-- 既存の物で変えるのは2つだけ。どちらも古いコードで壊れない形:
--   * notifications_type_check: 既存の type をすべて残して3つ足す。
--   * notification_feed(): 同じ引数・同じ戻り値の create or replace。like/help/join の10分まとめと、
--     それ以外を1行ずつ出す動きは変わらない（まとめの条件を「カテゴリが reaction」から
--     「type が like/help/join」に変えただけ。新しい type が同じ post_id=NULL で混ざらないため）。
--     島などの NULL の actor の others が -1 から 0 になる（画面は島を別に扱っているので見た目は変わらない）。
--
-- 保守モード（check_map_maintenance）のトリガーは、新しい表には付けない。保守は投稿から計算した値を
-- 作り直す間の書き込みを止めるためのもので、DM と押した記録はそれと無関係。press_talk と DM の
-- 新着通知は notifications に書くので、その表の保守トリガーで保守中は止まる。
-- 新着通知が止まっても、メッセージ自体は失わない（dm_messages_notify の中で握りつぶす）。
begin;

-- ===========================================================================
-- 1. Tables
-- ===========================================================================
create table if not exists public.talk_wishes (
  from_id       uuid not null references public.accounts (id) on delete cascade,
  to_id         uuid not null references public.accounts (id) on delete cascade,
  event_post_id uuid references public.posts (id) on delete set null,
  created_at    timestamptz not null default now(),
  primary key (from_id, to_id),
  check (from_id <> to_id)
);
create index if not exists talk_wishes_to_idx      on public.talk_wishes (to_id);
create index if not exists talk_wishes_created_idx on public.talk_wishes (created_at);

create table if not exists public.dm_rooms (
  id            uuid primary key default gen_random_uuid(),
  user_a        uuid not null references public.accounts (id) on delete cascade,
  user_b        uuid not null references public.accounts (id) on delete cascade,
  event_post_id uuid references public.posts (id) on delete set null,
  created_at    timestamptz not null default now(),
  check (user_a < user_b),
  unique (user_a, user_b)
);
create index if not exists dm_rooms_user_b_idx on public.dm_rooms (user_b);

create table if not exists public.dm_messages (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.dm_rooms (id) on delete cascade,
  sender_id  uuid not null references public.accounts (id) on delete cascade,
  -- 前後の空白（半角・全角・改行）を除いて1〜1000字。除く前も4000字まで。
  body       text not null
             check (length(btrim(body, E' \t\r\n　')) between 1 and 1000
                    and length(body) <= 4000),
  -- clock_timestamp(): 同じトランザクションの2通も別の時刻になる（now() は開始時刻で同点になる）。
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists dm_messages_room_idx   on public.dm_messages (room_id, created_at);
create index if not exists dm_messages_sender_idx on public.dm_messages (sender_id);

create table if not exists public.dm_blocks (
  blocker_id uuid not null references public.accounts (id) on delete cascade,
  blocked_id uuid not null references public.accounts (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists dm_blocks_blocked_idx on public.dm_blocks (blocked_id);

-- 日ごとの件数だけ。日は日本時間。
create table if not exists public.talk_stats (
  day     date primary key,
  pressed integer not null default 0 check (pressed >= 0),
  matched integer not null default 0 check (matched >= 0)
);

-- ===========================================================================
-- 2. Privileges and row level security
-- ===========================================================================
alter table public.talk_wishes enable row level security;
alter table public.dm_rooms    enable row level security;
alter table public.dm_messages enable row level security;
alter table public.dm_blocks   enable row level security;
alter table public.talk_stats  enable row level security;

revoke all on public.talk_wishes, public.dm_rooms, public.dm_messages,
              public.dm_blocks, public.talk_stats
  from anon, authenticated;

-- talk_wishes と talk_stats: 誰も入れない policy を1つだけ。サーバーのキー(service_role)は RLS を通らない。
drop policy if exists talk_wishes_none on public.talk_wishes;
drop policy if exists talk_stats_none  on public.talk_stats;
create policy talk_wishes_none on public.talk_wishes for all using (false) with check (false);
create policy talk_stats_none  on public.talk_stats  for all using (false) with check (false);
grant all on public.talk_wishes, public.talk_stats to service_role;

-- dm_rooms: 読めるのは自分が入っている部屋だけ。書くのは関数だけ（insert/update/delete の権限も policy も無い）。
drop policy if exists dm_rooms_select on public.dm_rooms;
create policy dm_rooms_select on public.dm_rooms for select to authenticated
  using (auth.uid() = user_a or auth.uid() = user_b);
grant select on public.dm_rooms to authenticated;
grant all on public.dm_rooms to service_role;

-- dm_messages: 読むのは部屋の2人だけ。送るのは本人の名前で、自分が入っている部屋にだけ
-- （ブロックの確認は下のトリガー dm_messages_guard。ブロックは相手から読めない表なので、policy の中では見えない）。
-- 更新・削除は許さない。
drop policy if exists dm_messages_select on public.dm_messages;
drop policy if exists dm_messages_insert on public.dm_messages;
create policy dm_messages_select on public.dm_messages for select to authenticated
  using (exists (select 1 from public.dm_rooms r
                  where r.id = dm_messages.room_id
                    and (auth.uid() = r.user_a or auth.uid() = r.user_b)));
create policy dm_messages_insert on public.dm_messages for insert to authenticated
  with check (sender_id = auth.uid()
              and exists (select 1 from public.dm_rooms r
                           where r.id = dm_messages.room_id
                             and (auth.uid() = r.user_a or auth.uid() = r.user_b)));
grant select on public.dm_messages to authenticated;
-- id と時刻は DB が決める。クライアントが書けるのはこの3列だけ。
grant insert (room_id, sender_id, body) on public.dm_messages to authenticated;
grant all on public.dm_messages to service_role;

-- dm_blocks: 自分のブロックだけ。
drop policy if exists dm_blocks_select on public.dm_blocks;
drop policy if exists dm_blocks_insert on public.dm_blocks;
drop policy if exists dm_blocks_delete on public.dm_blocks;
create policy dm_blocks_select on public.dm_blocks for select to authenticated
  using (blocker_id = auth.uid());
create policy dm_blocks_insert on public.dm_blocks for insert to authenticated
  with check (blocker_id = auth.uid());
create policy dm_blocks_delete on public.dm_blocks for delete to authenticated
  using (blocker_id = auth.uid());
grant select on public.dm_blocks to authenticated;
grant insert (blocker_id, blocked_id) on public.dm_blocks to authenticated;
grant delete on public.dm_blocks to authenticated;
grant all on public.dm_blocks to service_role;

-- ===========================================================================
-- 3. Notifications
-- ===========================================================================
-- 既存の type をすべて残して、talk_wish / talk_match / dm を足す。
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('like', 'help', 'join', 'comment', 'reply', 'connection', 'similar', 'island',
                  'quiet_post', 'talk_wish', 'talk_match', 'dm'));

-- like / help / join だけが10分以内に1行にまとまる。talk_wish / talk_match は反応の分類だが、
-- 1通ずつ出す（post_id が NULL どうしで混ざって人数が分かったり、名前つきと名前なしが混ざらないように）。
-- 分類: talk_wish, talk_match は reaction、dm は reply（設定画面は変えない）。
-- Python のミラー: core/notifications.py の group_feed と core/config.py の NOTIFICATION_CATEGORY_OF。
create or replace function public.notification_feed(limit_n integer default 50)
returns table (id uuid, type text, category text, post_id uuid, comment_id uuid,
               island_id uuid, event_id uuid, payload jsonb, actor_id uuid,
               others integer, created_at timestamptz, unread boolean, ids uuid[])
language sql stable security definer set search_path = public as $$
  with mine as (
    select n.*,
           case when n.type in ('like', 'help', 'join', 'talk_wish', 'talk_match') then 'reaction'
                when n.type in ('comment', 'reply', 'dm') then 'reply'
                when n.type = 'quiet_post' then 'similar'
                else n.type end as cat,
           n.type in ('like', 'help', 'join') as chainable
      from public.notifications n
     where n.recipient_id = auth.uid()
  ), chained as (
    select m.*,
           case when m.chainable
                 and lag(m.created_at) over w is not null
                 and m.created_at - lag(m.created_at) over w <= interval '10 minutes'
                then 0 else 1 end as starts
      from mine m
    window w as (partition by m.cat, m.post_id, m.chainable order by m.created_at)
  ), grouped as (
    select c.*,
           case when c.chainable
                then sum(c.starts) over (partition by c.cat, c.post_id, c.chainable order by c.created_at)
                else null end as chain,
           case when c.chainable then null else c.id end as solo
      from chained c
  )
  select (array_agg(g.id order by g.created_at desc))[1],
         (array_agg(g.type order by g.created_at desc))[1],
         g.cat,
         (array_agg(g.post_id order by g.created_at desc))[1],
         (array_agg(g.comment_id order by g.created_at desc))[1],
         (array_agg(g.island_id order by g.created_at desc))[1],
         (array_agg(g.event_id order by g.created_at desc))[1],
         (array_agg(g.payload order by g.created_at desc))[1],
         (array_agg(g.actor_id order by g.created_at desc))[1],
         greatest(count(distinct g.actor_id) - 1, 0)::int,
         max(g.created_at),
         bool_or(g.read_at is null),
         array_agg(g.id order by g.created_at desc)
    from grouped g
   group by g.cat, g.post_id, g.chainable, g.chain, g.solo
   order by max(g.created_at) desc
   limit greatest(1, least(limit_n, 200))
$$;

-- ===========================================================================
-- 4. Inside helpers (nobody outside calls these)
-- ===========================================================================
-- a と b が同じ会の仲間なら、その会のうち一番新しい投稿の id。なければ null。
create or replace function public.talk_shared_event(a uuid, b uuid)
returns uuid
language sql stable security definer set search_path = public as $$
  select p.id
    from public.posts p
   where a is not null and b is not null
     and p.deleted_at is null
     and '参加者募集中' = any(p.tags)
     and (p.author_id = a
          or exists (select 1 from public.reactions r
                      where r.post_id = p.id and r.actor_id = a and r.kind = 'join'))
     and (p.author_id = b
          or exists (select 1 from public.reactions r
                      where r.post_id = p.id and r.actor_id = b and r.kind = 'join'))
   order by p.created_at desc, p.id
   limit 1
$$;

-- どちら向きでもブロックがあるか。
create or replace function public.talk_blocked(a uuid, b uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.dm_blocks k
                  where (k.blocker_id = a and k.blocked_id = b)
                     or (k.blocker_id = b and k.blocked_id = a))
$$;

revoke all on function public.talk_shared_event(uuid, uuid) from public, anon, authenticated;
revoke all on function public.talk_blocked(uuid, uuid)      from public, anon, authenticated;

-- ===========================================================================
-- 5. What the browser calls (JWT of the signed-in person)
-- ===========================================================================
-- 自分と同じ会の仲間（自分以外）。どちら向きでもブロック関係にある人は除く。
create or replace function public.talk_peers()
returns table (account_id uuid)
language sql stable security definer set search_path = public as $$
  with mine as (
    select p.id as event_id, p.author_id
      from public.posts p
     where auth.uid() is not null
       and p.deleted_at is null
       and '参加者募集中' = any(p.tags)
       and (p.author_id = auth.uid()
            or exists (select 1 from public.reactions r
                        where r.post_id = p.id and r.actor_id = auth.uid() and r.kind = 'join'))
  ), others as (
    select m.author_id as person from mine m
    union
    select r.actor_id from mine m
      join public.reactions r on r.post_id = m.event_id and r.kind = 'join'
  )
  select o.person
    from others o
   where o.person <> auth.uid()
     and not public.talk_blocked(auth.uid(), o.person)
$$;

-- 押す。返り値は {"matched": bool, "room_id": uuid|null}。
-- 片思いのときと「すでに押していた」ときは、返り値も（外から見える）中身も同じ。
create or replace function public.press_talk(target uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me           uuid := auth.uid();
  lo           uuid;
  hi           uuid;
  shared_event uuid;
  found_room   uuid;
  new_rows     integer;
  -- 日本時間の日付。夏時間が無いので、時刻表を使わずに +9 時間で出す。
  today        date := ((now() at time zone 'UTC') + interval '9 hours')::date;
begin
  if me is null then
    raise exception 'ログインしてください。';
  end if;
  if target is null or target = me then
    raise exception '自分には押せません。';
  end if;
  -- 会の仲間でない・ブロック関係は、同じ文言（ブロックされたことを教えない）。
  shared_event := public.talk_shared_event(me, target);
  if shared_event is null or public.talk_blocked(me, target) then
    raise exception 'この相手には押せません。';
  end if;

  -- 同じ2人が同時に押しても、お互いの行を見逃さないよう、組ごとに順番に処理する。
  lo := least(me, target);
  hi := greatest(me, target);
  perform pg_advisory_xact_lock(hashtextextended(lo::text || ':' || hi::text, 0));

  -- ついでの掃除。2週間より古い片思いは消える。
  delete from public.talk_wishes where created_at < now() - interval '14 days';

  -- すでに部屋がある（両思い済み）。何も増やさない。
  select r.id into found_room from public.dm_rooms r where r.user_a = lo and r.user_b = hi;
  if found_room is not null then
    return jsonb_build_object('matched', true, 'room_id', found_room);
  end if;

  -- 相手がすでに自分を押していた: 両思い。
  if exists (select 1 from public.talk_wishes w where w.from_id = target and w.to_id = me) then
    insert into public.dm_rooms (user_a, user_b, event_post_id)
    values (lo, hi, shared_event)
    returning id into found_room;
    delete from public.talk_wishes
     where (from_id = me and to_id = target) or (from_id = target and to_id = me);
    -- 2人に名前つき（actor = 相手）。1つの insert なので、プッシュの合図も1回。
    insert into public.notifications (recipient_id, actor_id, type)
    values (me, target, 'talk_match'), (target, me, 'talk_match');
    insert into public.talk_stats (day, matched) values (today, 1)
    on conflict (day) do update set matched = public.talk_stats.matched + 1;
    return jsonb_build_object('matched', true, 'room_id', found_room);
  end if;

  -- 片思い。すでに押していたら何もしない（通知も件数も増やさない）。
  insert into public.talk_wishes (from_id, to_id, event_post_id)
  values (me, target, shared_event)
  on conflict (from_id, to_id) do nothing;
  get diagnostics new_rows = row_count;
  if new_rows > 0 then
    -- 名前なし・会なし（actor_id, post_id などはすべて NULL）。受け取る人に直近24時間の
    -- talk_wish があれば（読んだかどうかに関係なく）足さない。行の数で押した人数が分からないように、
    -- そして「押す→取り消す→押す」で匿名の通知を送り続けられないように。
    insert into public.notifications (recipient_id, actor_id, type)
    select target, null::uuid, 'talk_wish'
     where not exists (select 1 from public.notifications n
                        where n.recipient_id = target and n.type = 'talk_wish'
                          and n.created_at > now() - interval '24 hours');
    insert into public.talk_stats (day, pressed) values (today, 1)
    on conflict (day) do update set pressed = public.talk_stats.pressed + 1;
  end if;
  return jsonb_build_object('matched', false, 'room_id', null::uuid);
end $$;

-- 片思いを取り消す。両思いのあと（行はもう無い）は何も起きない。送った通知は消さない。
create or replace function public.withdraw_talk(target uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'ログインしてください。';
  end if;
  delete from public.talk_wishes where from_id = auth.uid() and to_id = target;
end $$;

-- 自分が押した相手(pressed)と、DM が開いている相手(matched)。相手から押されているかは返さない。
create or replace function public.my_talk_state()
returns table (target uuid, state text, room_id uuid)
language sql stable security definer set search_path = public as $$
  select w.to_id, 'pressed'::text, null::uuid
    from public.talk_wishes w
   where w.from_id = auth.uid()
     and w.created_at > now() - interval '14 days'
  union all
  select case when r.user_a = auth.uid() then r.user_b else r.user_a end, 'matched'::text, r.id
    from public.dm_rooms r
   where auth.uid() = r.user_a or auth.uid() = r.user_b
$$;

-- 自分の部屋の一覧。新しいやりとりが上。
create or replace function public.dm_room_list()
returns table (room_id uuid, other_id uuid, other_name text, other_icon_id text,
               other_avatar_path text, event_post_id uuid, event_excerpt text,
               last_body text, last_at timestamptz, blocked_by_me boolean,
               created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.id, o.id, o.display_name, o.icon_id, o.avatar_path,
         case when p.deleted_at is null then p.id end,
         case when p.deleted_at is null then left(p.body, 30) end,
         left(lm.body, 60), lm.created_at,
         exists (select 1 from public.dm_blocks k
                  where k.blocker_id = auth.uid() and k.blocked_id = o.id),
         r.created_at
    from public.dm_rooms r
    join public.accounts o
      on o.id = case when r.user_a = auth.uid() then r.user_b else r.user_a end
    left join public.posts p on p.id = r.event_post_id
    left join lateral (select mm.body, mm.created_at
                         from public.dm_messages mm
                        where mm.room_id = r.id
                        order by mm.created_at desc, mm.id desc
                        limit 1) lm on true
   where auth.uid() = r.user_a or auth.uid() = r.user_b
   order by coalesce(lm.created_at, r.created_at) desc
$$;

revoke all on function public.talk_peers()           from public, anon;
revoke all on function public.press_talk(uuid)       from public, anon;
revoke all on function public.withdraw_talk(uuid)    from public, anon;
revoke all on function public.my_talk_state()        from public, anon;
revoke all on function public.dm_room_list()         from public, anon;
grant execute on function public.talk_peers()        to authenticated;
grant execute on function public.press_talk(uuid)    to authenticated;
grant execute on function public.withdraw_talk(uuid) to authenticated;
grant execute on function public.my_talk_state()     to authenticated;
grant execute on function public.dm_room_list()      to authenticated;

-- ===========================================================================
-- 6. Triggers on dm_messages
-- ===========================================================================
-- 送る前: 部屋の2人のどちらかで、どちら向きにもブロックが無いこと。ブロックは相手から読めない表なので、
-- policy ではなくここで見る。サーバーのキー(service_role)の書き込みにも効く。
-- 断る文言は RLS の拒否と同じ 42501（ブロックされたことを教えない）。
create or replace function public.dm_messages_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  ua uuid;
  ub uuid;
begin
  select r.user_a, r.user_b into ua, ub from public.dm_rooms r where r.id = new.room_id;
  if not found or new.sender_id not in (ua, ub)
     or public.talk_blocked(ua, ub) then
    raise exception 'このDMには送信できません。' using errcode = '42501';
  end if;
  return new;
end $$;

-- 送った後: 相手に type='dm' の通知（actor = 送った人）。同じ相手から同じ人宛てに未読の dm が
-- すでにあり、かつ直近10分以内なら足さない（1つの部屋は2人だけなので、送った人で部屋が決まる）。
-- 10分を過ぎたら、読まれていなくても足す（部屋を直接開いた人は通知を既読にしないので、
-- いつまでも止まらないように）。本文は入れない。
create or replace function public.dm_messages_notify()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  other uuid;
begin
  select case when r.user_a = new.sender_id then r.user_b else r.user_a end
    into other
    from public.dm_rooms r where r.id = new.room_id;
  if other is null then
    return new;
  end if;
  begin
    if not exists (select 1 from public.notifications n
                    where n.recipient_id = other and n.actor_id = new.sender_id
                      and n.type = 'dm' and n.read_at is null
                      and n.created_at > now() - interval '10 minutes') then
      insert into public.notifications (recipient_id, actor_id, type)
      values (other, new.sender_id, 'dm');
    end if;
  exception when others then
    -- 通知が書けない（保守中など）ことで、送ったメッセージを失わない。
    null;
  end;
  return new;
end $$;

revoke all on function public.dm_messages_guard()  from public, anon, authenticated;
revoke all on function public.dm_messages_notify() from public, anon, authenticated;

drop trigger if exists dm_messages_guard on public.dm_messages;
create trigger dm_messages_guard before insert on public.dm_messages
  for each row execute function public.dm_messages_guard();
drop trigger if exists dm_messages_notify on public.dm_messages;
create trigger dm_messages_notify after insert on public.dm_messages
  for each row execute function public.dm_messages_notify();

commit;
