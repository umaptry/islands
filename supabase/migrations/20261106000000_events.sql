-- 2026-11-06: イベント申し込み（会・申し込み・LINE・予約送信・probe）。第2回a の M3。
--
-- 設計: 設計_イベント申し込み D（1 章 / 2-3 / 7 章 / 8 章）、C（1 章データ・2-9 状態の動き）、E（規約が約束していること）。
-- 流す順番: M1（20261101000000）→ M2（20261101010000）→ この M3。M4（受付・会えてよかった・片付け）は別の回。
--
--   * 表（9つ）  events / event_registrations / event_answers / event_meetings / line_links /
--               outbound_messages / line_webhook_events / event_probe_hits / line_pending_friends（先に友だち追加した人）。
--               どれも invite_claims と同じ形: RLS 有効 ＋ 全拒否の policy ＋ anon・authenticated の権限なし ＋ service_role だけ。
--               ブラウザは1つも直接読み書きできない（読み書きはサーバーが service_role で関数を呼ぶ）。
--   * 通知の種類  M1 の15種類に event_late（主催者へ「遅れます」）・event_cancel（主催者へ「取り消しました」）・
--               event_cancelled（メンバーへ「会が中止になりました」。8 章の決定）を足して 18 種類。
--   * トリガー   reactions_event_join_guard … 会の投稿の join は、サーバー（service_role）だけが入れる・消す。
--               events_on_post_delete      … 会の投稿を消すと会が中止になる（未送信の予定を消し、申し込み中の人へ中止の知らせ）。
--   * 守りの作り直し accounts_invite_guard … 申し込みの行があれば accounts を作れる。
--               account_visible … 「自分が主催者の会に、申し込み中・受付済み・受付待ちで登録している人」を足す。
--   * 関数（サーバーだけ。service_role）  event_create / event_update / event_apply / event_cancel_registration /
--               event_set_late / event_decline / event_answer_vectors / account_by_line_sub / line_link_save /
--               line_link_attach / my_event_registrations / line_link_unfollow / line_webhook_seen / outbound_claim / outbound_done / event_probe_hit。
--   * 関数（中だけ）  has_live_registration / event_questions_valid / event_queue_reminders / トリガー関数。
--   * 予約送信（jobs_poke と pg_cron）は、この SQL には入れない。pg_cron・pg_net・Vault が要るので、
--     相方が拡張を有効にしたあとに流す別ファイル（本番SQL_第2回a… の 4_予約送信_pg_cron.sql）に分けた。
--
-- 古いコードのまま先に流しても壊れない: 足す・作り直すだけ。会の投稿に join を入れるのはサーバーの新しいコードだけで、
-- 今の画面は会の投稿を作らない。accounts_invite_guard / account_visible は今までの条件を全部残して1つ足すだけ。
--
-- 足す・作り直すだけで、何度流しても壊れない。1本 = 1 transaction。
-- 戻すときは supabase/rollback/20261106000000_events_rollback.sql（コードを先に戻してから）。
begin;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- ===========================================================================
-- 1. 質問の形を確かめる関数（中だけ。表の check からも使う）
-- ===========================================================================
-- 最大3問。prompt は now / past / future だけ（talk は使わない。8 章）。同じ prompt は1回まで。
-- label は 1〜100 字、hint は省略か 200 字まで。
create or replace function public.event_questions_valid(q jsonb)
returns boolean
language plpgsql immutable set search_path = public as $$
declare
  e    jsonb;
  pr   text;
  seen text[] := '{}';
begin
  if q is null or jsonb_typeof(q) <> 'array' or jsonb_array_length(q) > 3 then
    return false;
  end if;
  for e in select x from jsonb_array_elements(q) x loop
    if jsonb_typeof(e) <> 'object' then
      return false;
    end if;
    pr := e ->> 'prompt';
    if pr is null or pr not in ('now', 'past', 'future') or pr = any (seen) then
      return false;
    end if;
    seen := seen || pr;
    if jsonb_typeof(e -> 'label') is distinct from 'string'
       or length(e ->> 'label') not between 1 and 100 then
      return false;
    end if;
    if e ? 'hint' and jsonb_typeof(e -> 'hint') <> 'null'
       and (jsonb_typeof(e -> 'hint') <> 'string' or length(e ->> 'hint') > 200) then
      return false;
    end if;
  end loop;
  return true;
end $$;
revoke all on function public.event_questions_valid(jsonb) from public, anon, authenticated;

-- ===========================================================================
-- 2. 表
-- ===========================================================================
-- 会（投稿1件に1行）。定員・申込期限は posts.recruit_capacity / recruit_deadline、主催者は posts.author_id。
-- 受付の時間帯は列に持たない（開始の3時間前〜終了の2時間後。M4）。
create table if not exists public.events (
  post_id      uuid primary key references public.posts (id) on delete cascade,
  community_id uuid not null references public.communities (id) on delete cascade,
  title        text not null check (length(title) between 1 and 40),
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  place        text not null default '' check (length(place) <= 60),
  visibility   text not null default 'community' check (visibility in ('public', 'community')),
  questions    jsonb not null default '[]'::jsonb check (public.event_questions_valid(questions)),
  public_code  text not null unique check (length(public_code) >= 22),
  checkin_code text not null unique check (length(checkin_code) >= 22),
  cancelled_at timestamptz,
  created_at   timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists events_community_idx on public.events (community_id);
create index if not exists events_ends_idx on public.events (ends_at);

-- 申し込み。account_id は auth.users を指す（accounts より先に行を入れて、accounts_invite_guard を通すため）。
create table if not exists public.event_registrations (
  event_id        uuid not null references public.events (post_id) on delete cascade,
  account_id      uuid not null references auth.users (id) on delete cascade,
  status          text not null check (status in ('applied', 'attended', 'cancelled', 'declined', 'waiting')),
  consent_version text,
  was_guest       boolean not null default false,
  created_account boolean not null default false,
  channel         text not null check (channel in ('line', 'email', 'walkin')),
  referral        text check (referral is null or length(referral) <= 40),
  late_minutes    smallint check (late_minutes is null or late_minutes in (10, 30, 60)),
  late_at         timestamptz,
  applied_at      timestamptz not null default now(),
  checked_in_at   timestamptz,
  cancelled_at    timestamptz,
  declined_at     timestamptz,
  declined_by     uuid references public.accounts (id) on delete set null,
  walkin_rejects  smallint not null default 0 check (walkin_rejects between 0 and 3),
  primary key (event_id, account_id)
);
create index if not exists event_registrations_account_idx on public.event_registrations (account_id);
create index if not exists event_registrations_status_idx on public.event_registrations (event_id, status);

-- 受付前の回答。受付（M4）で posts に移して消す。それまで posts には入らない（地図に出ない）。
-- vec 以降の列は posts の同名の列と同じ型・同じ not null（M4 がそのまま写せる）。
create table if not exists public.event_answers (
  event_id   uuid not null,
  account_id uuid not null,
  prompt     text not null check (prompt in ('past', 'now', 'future', 'help')),
  body       text not null check (length(body) between 1 and 60),
  vec        vector(448) not null,
  vec_c      vector(448) not null,
  x          double precision not null,
  y          double precision not null,
  cluster_id smallint not null,
  terms      jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  primary key (event_id, account_id, prompt),
  foreign key (event_id, account_id) references public.event_registrations (event_id, account_id) on delete cascade
);

-- 会えてよかった（M4 で使う。表だけ先に）。
create table if not exists public.event_meetings (
  event_id   uuid not null references public.events (post_id) on delete cascade,
  from_id    uuid not null references public.accounts (id) on delete cascade,
  to_id      uuid not null references public.accounts (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, from_id, to_id),
  check (from_id <> to_id)
);

-- LINE との結びつけ。受け取るのは userId・友だちの状態だけ（E の 1・2: 表示名・画像・メッセージ本文は持たない）。
create table if not exists public.line_links (
  account_id    uuid primary key references auth.users (id) on delete cascade,
  line_user_id  text not null unique,
  is_friend     boolean not null default true,
  followed_at   timestamptz,
  unfollowed_at timestamptz,
  created_at    timestamptz not null default now()
);

-- まだアカウントに結びついていない LINE の友だち（islands のアカウントより先に公式アカウントを友だち追加した人）。
-- userId と友だちの状態だけ（E の 1・2）。申し込み・ログインで結びついたら消す（line_link_attach）。
create table if not exists public.line_pending_friends (
  line_user_id  text primary key,
  is_friend     boolean not null,
  followed_at   timestamptz,
  unfollowed_at timestamptz,
  updated_at    timestamptz not null default now()
);

-- 送る予定。会の7日後に全部消す（E の 5）。
create table if not exists public.outbound_messages (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null,
  account_id   uuid not null,
  kind         text not null check (kind in ('week_before', 'day_of', 'after', 'declined', 'event_cancelled', 'event_changed')),
  scheduled_at timestamptz not null,
  claimed_at   timestamptz,
  sent_at      timestamptz,
  attempts     smallint not null default 0,
  last_error   text,
  unique (event_id, account_id, kind),
  foreign key (event_id, account_id) references public.event_registrations (event_id, account_id) on delete cascade
);
create index if not exists outbound_messages_due_idx on public.outbound_messages (scheduled_at) where sent_at is null;

-- LINE の webhook の二重受け取りを防ぐ記録。本文は持たない。30日で消す（E の 4）。
create table if not exists public.line_webhook_events (
  webhook_event_id text primary key,
  received_at      timestamptz not null default now()
);
create index if not exists line_webhook_events_received_idx on public.line_webhook_events (received_at);

-- 「近い人が来るか見てみる」の回数の数え。cookie の番号と IP のハッシュの記録は、翌日には消す（E の 6）。
-- device: cookie のハッシュ／ 'ip:' || IP のハッシュ／ '*'（会全体）。day は日本時間。
create table if not exists public.event_probe_hits (
  event_id uuid not null references public.events (post_id) on delete cascade,
  device   text not null,
  day      date not null,
  n        integer not null default 0,
  primary key (event_id, device, day)
);
create index if not exists event_probe_hits_day_idx on public.event_probe_hits (day);

-- 8つとも全拒否。サーバーのキー（service_role）は RLS を通らない。
alter table public.events               enable row level security;
alter table public.event_registrations  enable row level security;
alter table public.event_answers        enable row level security;
alter table public.event_meetings       enable row level security;
alter table public.line_links           enable row level security;
alter table public.outbound_messages    enable row level security;
alter table public.line_webhook_events  enable row level security;
alter table public.event_probe_hits     enable row level security;
alter table public.line_pending_friends enable row level security;
revoke all on public.events, public.event_registrations, public.event_answers, public.event_meetings,
              public.line_links, public.outbound_messages, public.line_webhook_events, public.event_probe_hits,
              public.line_pending_friends
  from anon, authenticated;
grant all on public.events, public.event_registrations, public.event_answers, public.event_meetings,
             public.line_links, public.outbound_messages, public.line_webhook_events, public.event_probe_hits,
             public.line_pending_friends
  to service_role;
drop policy if exists events_none              on public.events;
drop policy if exists event_registrations_none on public.event_registrations;
drop policy if exists event_answers_none       on public.event_answers;
drop policy if exists event_meetings_none      on public.event_meetings;
drop policy if exists line_links_none          on public.line_links;
drop policy if exists outbound_messages_none   on public.outbound_messages;
drop policy if exists line_webhook_events_none on public.line_webhook_events;
drop policy if exists event_probe_hits_none    on public.event_probe_hits;
drop policy if exists line_pending_friends_none on public.line_pending_friends;
create policy events_none              on public.events              for all using (false) with check (false);
create policy event_registrations_none on public.event_registrations for all using (false) with check (false);
create policy event_answers_none       on public.event_answers       for all using (false) with check (false);
create policy event_meetings_none      on public.event_meetings      for all using (false) with check (false);
create policy line_links_none          on public.line_links          for all using (false) with check (false);
create policy outbound_messages_none   on public.outbound_messages   for all using (false) with check (false);
create policy line_webhook_events_none on public.line_webhook_events for all using (false) with check (false);
create policy event_probe_hits_none    on public.event_probe_hits    for all using (false) with check (false);
create policy line_pending_friends_none on public.line_pending_friends for all using (false) with check (false);

-- ===========================================================================
-- 3. 通知の種類（M1 の15種類を全部残して、3つ足す）
-- ===========================================================================
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('like', 'help', 'join', 'comment', 'reply', 'connection', 'similar', 'island',
                  'quiet_post', 'talk_wish', 'talk_match', 'dm', 'match',
                  'join_request', 'join_approved',
                  'event_late', 'event_cancel', 'event_cancelled'));

-- ===========================================================================
-- 4. 中だけの関数
-- ===========================================================================
-- 生きた申し込みがあるか: applied / waiting / attended で、会が中止されておらず、終了から7日（EVENT_CLEANUP_DAYS）を
-- 過ぎていない。アカウントごと消してよいかの判断に使う（M4 の片付け・Python）。
create or replace function public.has_live_registration(account uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1
                   from public.event_registrations r
                   join public.events e on e.post_id = r.event_id
                  where r.account_id = has_live_registration.account
                    and r.status in ('applied', 'waiting', 'attended')
                    and e.cancelled_at is null
                    and e.ends_at + interval '7 days' > now())
$$;
revoke all on function public.has_live_registration(uuid) from public, anon, authenticated;

-- 1人分の案内の予定を作る: 1週間前の同じ時刻（week_before）・開始の3時間前（day_of）・終了時（after）。
-- 過ぎている時刻の分は作らない。すでに行があれば時刻を更新して「未送信」に戻す（再申し込み・日時の変更）。
create or replace function public.event_queue_reminders(p_event uuid, p_account uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  ev public.events%rowtype;
begin
  select e.* into ev from public.events e where e.post_id = p_event;
  if not found then
    return;
  end if;
  insert into public.outbound_messages (event_id, account_id, kind, scheduled_at)
  select p_event, p_account, k.kind, k.at
    from (values ('week_before', ev.starts_at - interval '7 days'),
                 ('day_of',      ev.starts_at - interval '3 hours'),
                 ('after',       ev.ends_at)) as k (kind, at)
   where k.at > now()
  on conflict (event_id, account_id, kind) do update
    set scheduled_at = excluded.scheduled_at, sent_at = null, claimed_at = null, attempts = 0, last_error = null;
end $$;
revoke all on function public.event_queue_reminders(uuid, uuid) from public, anon, authenticated;

-- ===========================================================================
-- 5. トリガー
-- ===========================================================================
-- 会の投稿の join は、サーバー（auth.uid() が null）だけが入れる・消す。ブラウザ（ログイン中）が直接 reactions を
-- 触ろうとしたら断る。ただし退会（accounts の削除）の連鎖で反応が消えるとき（pg_trigger_depth() > 1）は止めない。
-- メンバーでない人には、会かどうかを教えず素通りさせる（そのあと RLS が 42501 で断る。reactions_recruit_guard と同じ）。
create or replace function public.reactions_event_join_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  pid  uuid := case when tg_op = 'DELETE' then old.post_id else new.post_id end;
  kind text := case when tg_op = 'DELETE' then old.kind    else new.kind    end;
begin
  if kind = 'join'
     and auth.uid() is not null
     and pg_trigger_depth() = 1
     and exists (select 1 from public.events e where e.post_id = pid)
     and (tg_op = 'DELETE' or public.is_member_of_post(pid)) then
    raise exception '会への参加は、申し込みから行ってください。'
      using errcode = 'P0001', hint = 'event_use_apply';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function public.reactions_event_join_guard() from public, anon, authenticated;

drop trigger if exists reactions_event_join_guard on public.reactions;
create trigger reactions_event_join_guard
  before insert or delete on public.reactions
  for each row execute function public.reactions_event_join_guard();

-- 会の投稿を消すと、会が中止になる。
--   * events.cancelled_at を入れる
--   * 未送信の予定を全部消す
--   * LINE で申し込んだ申し込み中の人へ、中止の予定（event_cancelled）を今すぐ送る形で入れる
--   * 申し込み中のコミュニティのメンバーへ、アプリ内の通知 event_cancelled（8 章の決定）
-- 中身は begin … exception … end で包む: 通知などで何が失敗しても、投稿の削除は止めない。
create or replace function public.events_on_post_delete()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  ev public.events%rowtype;
begin
  begin
    select e.* into ev from public.events e where e.post_id = new.id;
    if found then
      update public.events set cancelled_at = coalesce(cancelled_at, now()) where post_id = new.id;
      delete from public.outbound_messages o where o.event_id = new.id and o.sent_at is null;
      insert into public.outbound_messages (event_id, account_id, kind, scheduled_at)
      select r.event_id, r.account_id, 'event_cancelled', now()
        from public.event_registrations r
       where r.event_id = new.id and r.status = 'applied' and r.channel = 'line'
      on conflict (event_id, account_id, kind) do update
        set scheduled_at = now(), sent_at = null, claimed_at = null, attempts = 0, last_error = null;
      insert into public.notifications (recipient_id, actor_id, post_id, type, community_id, payload)
      select r.account_id, new.author_id, new.id, 'event_cancelled', ev.community_id,
             jsonb_build_object('title', ev.title)
        from public.event_registrations r
        join public.community_members m on m.community_id = ev.community_id and m.account_id = r.account_id
       where r.event_id = new.id and r.status = 'applied' and r.account_id <> new.author_id;
    end if;
  exception when others then
    raise warning 'events_on_post_delete: %', sqlerrm;
  end;
  return new;
end $$;
revoke all on function public.events_on_post_delete() from public, anon, authenticated;

drop trigger if exists events_on_post_delete on public.posts;
create trigger events_on_post_delete
  after update of deleted_at on public.posts
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function public.events_on_post_delete();

-- ===========================================================================
-- 6. 守りの作り直し
-- ===========================================================================
-- accounts_invite_guard: 今の定義（20261026010000）に1つ足す。申し込みの行があれば accounts を作れる。
-- 順番: 1. その id の行がすでにある → 通す／ 2. invite_only が true でなければ通す／
--       3. invite_claims に自分がいれば通す／ 4. 【新】event_registrations に自分の行があれば通す／ 5. それ以外は止める。
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
  if exists (select 1 from public.event_registrations r where r.account_id = new.id) then
    return new;
  end if;
  raise exception 'islands は招待制です。コミュニティの招待リンクから登録してください。'
    using errcode = 'P0001', hint = 'invite_required';
end $$;
revoke all on function public.accounts_invite_guard() from public, anon, authenticated;

-- account_visible: M2 の定義に1つ足す。自分が主催者の会に、申し込み中・受付済み・受付待ちで登録している人
-- （主催者が、通知や名簿でゲストの名前を読むため）。
create or replace function public.account_visible(other uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select other = (select auth.uid())
      or public.shares_community_with(other)
      or exists (select 1 from public.dm_rooms r
                  where (r.user_a = (select auth.uid()) and r.user_b = other)
                     or (r.user_b = (select auth.uid()) and r.user_a = other))
      -- 自分が管理者のコミュニティに、承認待ち（pending）として申し込んでいる人（M1）
      or exists (select 1 from public.community_join_requests q
                  join public.community_members m on m.community_id = q.community_id
                 where q.account_id = other and q.status = 'pending'
                   and m.account_id = (select auth.uid()) and m.role = 'admin')
      -- 自分が主催者の会に、申し込み中・受付済み・受付待ちで登録している人（M3）
      or exists (select 1 from public.event_registrations g
                  join public.posts p on p.id = g.event_id
                 where g.account_id = other and g.status in ('applied', 'attended', 'waiting')
                   and p.author_id = (select auth.uid()))
$$;
revoke all on function public.account_visible(uuid) from public, anon;
grant execute on function public.account_visible(uuid) to authenticated;

-- ===========================================================================
-- 7. サーバーの関数（②）: 会を作る・変える
-- ===========================================================================
-- 会を作る。投稿の保存は先に Python が行う。この関数が失敗したら Python が soft_delete_post で戻す。
-- 返り値 {"post_id", "public_code", "checkin_code"}。同じ投稿でもう一度呼ぶと、同じコードを返す。
create or replace function public.event_create(
  p_post uuid, p_actor uuid, p_title text, p_starts timestamptz, p_ends timestamptz,
  p_place text, p_visibility text, p_questions jsonb
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  po   record;
  ev   public.events%rowtype;
  vis  text := coalesce(p_visibility, 'community');
  qs   jsonb := coalesce(p_questions, '[]'::jsonb);
begin
  select p.author_id, p.community_id, p.deleted_at, p.tags, p.recruit_capacity, p.share_group
    into po
    from public.posts p where p.id = p_post;
  if not found or po.deleted_at is not null then
    raise exception 'この会は見つかりません。' using errcode = 'P0001', hint = 'event_not_found';
  end if;
  if po.author_id is distinct from p_actor then
    raise exception 'この会の主催者だけが行えます。' using errcode = 'P0001', hint = 'event_not_host';
  end if;
  select * into ev from public.events e where e.post_id = p_post;
  if found then
    return jsonb_build_object('post_id', ev.post_id, 'public_code', ev.public_code, 'checkin_code', ev.checkin_code);
  end if;
  if po.community_id is null
     or not ('参加者募集中' = any (po.tags))
     or po.recruit_capacity is null
     or po.share_group is not null
     or vis not in ('public', 'community')
     or not public.event_questions_valid(qs)
     or p_title is null or length(p_title) not between 1 and 40
     or p_starts is null or p_ends is null or p_ends <= p_starts
     or length(coalesce(p_place, '')) > 60 then
    raise exception '会の内容を確かめてください。' using errcode = 'P0001', hint = 'event_invalid';
  end if;
  if vis = 'public' and not exists (select 1 from public.community_members m
                                     where m.community_id = po.community_id and m.account_id = p_actor
                                       and m.role = 'admin') then
    raise exception '公開の会は、コミュニティの管理者だけが作れます。' using errcode = 'P0001', hint = 'public_admin_only';
  end if;
  insert into public.events (post_id, community_id, title, starts_at, ends_at, place, visibility, questions,
                             public_code, checkin_code)
  values (p_post, po.community_id, p_title, p_starts, p_ends, coalesce(p_place, ''), vis, qs,
          public.make_invite_code(), public.make_invite_code())
  returning * into ev;
  return jsonb_build_object('post_id', ev.post_id, 'public_code', ev.public_code, 'checkin_code', ev.checkin_code);
end $$;

-- 会を変える。p_fields のキー: title / starts_at / ends_at / place / questions（入っているものだけ変える）。
-- 日時・場所が変わったら、未送信の案内を作り直し、LINE の申し込み中の人へ event_changed を1通入れる。
-- 返り値 {"changed": 何か変わったか, "notified": event_changed を入れた人数}。
create or replace function public.event_update(p_post uuid, p_actor uuid, p_fields jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ev       public.events%rowtype;
  po       record;
  f        jsonb := coalesce(p_fields, '{}'::jsonb);
  n_title  text;
  n_starts timestamptz;
  n_ends   timestamptz;
  n_place  text;
  n_qs     jsonb;
  when_changed boolean;
  any_changed  boolean;
  r        record;
  notified integer := 0;
begin
  select p.author_id, p.deleted_at into po from public.posts p where p.id = p_post;
  select e.* into ev from public.events e where e.post_id = p_post for update;
  if not found or po.deleted_at is not null and ev.cancelled_at is null then
    raise exception 'この会は見つかりません。' using errcode = 'P0001', hint = 'event_not_found';
  end if;
  if po.author_id is distinct from p_actor then
    raise exception 'この会の主催者だけが行えます。' using errcode = 'P0001', hint = 'event_not_host';
  end if;
  if ev.cancelled_at is not null then
    raise exception 'この会は中止になりました。' using errcode = 'P0001', hint = 'event_cancelled';
  end if;
  n_title  := case when f ? 'title'     then f ->> 'title'              else ev.title end;
  n_starts := case when f ? 'starts_at' then (f ->> 'starts_at')::timestamptz else ev.starts_at end;
  n_ends   := case when f ? 'ends_at'   then (f ->> 'ends_at')::timestamptz   else ev.ends_at end;
  n_place  := case when f ? 'place'     then coalesce(f ->> 'place', '')  else ev.place end;
  n_qs     := case when f ? 'questions' then f -> 'questions'             else ev.questions end;
  if n_title is null or length(n_title) not between 1 and 40
     or n_starts is null or n_ends is null or n_ends <= n_starts
     or length(n_place) > 60
     or not public.event_questions_valid(n_qs) then
    raise exception '会の内容を確かめてください。' using errcode = 'P0001', hint = 'event_invalid';
  end if;
  when_changed := n_starts <> ev.starts_at or n_ends <> ev.ends_at or n_place <> ev.place;
  any_changed  := when_changed or n_title <> ev.title or n_qs <> ev.questions;
  if not any_changed then
    return jsonb_build_object('changed', false, 'notified', 0);
  end if;
  update public.events
     set title = n_title, starts_at = n_starts, ends_at = n_ends, place = n_place, questions = n_qs
   where post_id = p_post;
  if when_changed then
    delete from public.outbound_messages o
     where o.event_id = p_post and o.sent_at is null and o.kind in ('week_before', 'day_of', 'after');
    for r in select g.account_id from public.event_registrations g
              where g.event_id = p_post and g.status = 'applied' and g.channel = 'line' loop
      perform public.event_queue_reminders(p_post, r.account_id);
      insert into public.outbound_messages (event_id, account_id, kind, scheduled_at)
      values (p_post, r.account_id, 'event_changed', now())
      on conflict (event_id, account_id, kind) do update
        set scheduled_at = now(), sent_at = null, claimed_at = null, attempts = 0, last_error = null;
      notified := notified + 1;
    end loop;
  end if;
  return jsonb_build_object('changed', true, 'notified', notified);
end $$;

-- ===========================================================================
-- 8. サーバーの関数（②）: 申し込み・取り消し・遅れる・お断り
-- ===========================================================================
-- 申し込む。1つの transaction で「申し込みの行 → accounts（無ければ作る）→ reactions に join → 回答 → 送る予定」。
-- どこかで失敗したら全部なかったことになる（定員いっぱいの recruit_full・期限切れの recruit_closed もそのまま上がる）。
--   p_profile: {"display_name","affiliation","age_band","job_title"}。accounts が無い人、または name_confirmed_at が
--              無い人は display_name（1〜24字）と affiliation（1〜32字）が要る（name_required）。
--   p_answers: [{"prompt","body","vec","vec_c","x","y","cluster_id","terms"}]。vec・vec_c は pgvector の文字列。
--              メンバーでない人は、会の質問のうち2つ（質問が1つしか無い会は1つ、無い会は0）に答える（answers_required）。
--   p_channel: 'line' または 'email'。LINE で申し込んだ人にだけ案内の予定を作る（E の 14）。
-- 返り値 {"status": "applied"|"already", "is_member", "was_guest", "created_account", "remaining"}。
create or replace function public.event_apply(
  p_event uuid, p_account uuid, p_profile jsonb, p_channel text, p_referral text, p_answers jsonb, p_consent text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ev          public.events%rowtype;
  po          record;
  reg         public.event_registrations%rowtype;
  is_mem      boolean;
  acct_exists boolean;
  confirmed   timestamptz;
  need_name   boolean;
  nm          text;
  aff         text;
  ab          text;
  jt          text;
  created     boolean := false;
  q_count     integer;
  need_ans    integer;
  valid_ans   jsonb := '[]'::jsonb;
  a           jsonb;
  pr          text;
  bd          text;
  seen        text[] := '{}';
  remaining   integer;
  ref         text := nullif(left(btrim(coalesce(p_referral, '')), 40), '');
  consent     text := nullif(left(btrim(coalesce(p_consent, '')), 32), '');
begin
  if p_account is null then
    raise exception 'ログインしてください。' using errcode = 'P0001', hint = 'not_logged_in';
  end if;
  select e.* into ev from public.events e where e.post_id = p_event;
  select p.author_id, p.deleted_at, p.recruit_capacity into po from public.posts p where p.id = p_event;
  if not found or ev.post_id is null then
    raise exception 'この会は見つかりません。' using errcode = 'P0001', hint = 'event_not_found';
  end if;
  if ev.cancelled_at is not null or po.deleted_at is not null then
    raise exception 'この会は中止になりました。' using errcode = 'P0001', hint = 'event_cancelled';
  end if;
  is_mem := exists (select 1 from public.community_members m
                     where m.community_id = ev.community_id and m.account_id = p_account);
  -- お断り（この会）、外された・断られた人（このコミュニティ）は申し込めない
  if exists (select 1 from public.event_registrations r
              where r.event_id = p_event and r.account_id = p_account and r.status = 'declined')
     or (not is_mem and (exists (select 1 from public.community_removals x
                                  where x.community_id = ev.community_id and x.account_id = p_account)
                         or exists (select 1 from public.community_join_requests q
                                     where q.community_id = ev.community_id and q.account_id = p_account
                                       and q.status = 'rejected'))) then
    raise exception 'このコミュニティの会には申し込めません。' using errcode = 'P0001', hint = 'event_banned';
  end if;
  if ev.visibility = 'community' and not is_mem then
    raise exception 'この会は、コミュニティのメンバーだけが申し込めます。' using errcode = 'P0001', hint = 'event_members_only';
  end if;

  select r.* into reg from public.event_registrations r
   where r.event_id = p_event and r.account_id = p_account for update;
  if found and reg.status in ('applied', 'attended', 'waiting') then
    return jsonb_build_object('status', 'already', 'is_member', is_mem, 'was_guest', reg.was_guest,
                              'created_account', reg.created_account,
                              'remaining', (select p.recruit_capacity - p.join_count from public.posts p where p.id = p_event));
  end if;

  -- 名前（accounts の行が無い人、またはフルネームの確認がまだの人は必須）
  select exists (select 1 from public.accounts a where a.id = p_account) into acct_exists;
  if acct_exists then
    select a.name_confirmed_at into confirmed from public.accounts a where a.id = p_account;
  end if;
  need_name := not acct_exists or confirmed is null;
  nm  := btrim(coalesce(p_profile ->> 'display_name', ''));
  aff := btrim(coalesce(p_profile ->> 'affiliation', ''));
  ab  := p_profile ->> 'age_band';
  if ab not in ('10s', '20s', '30s', '40s', '50s', '60s') then
    ab := null;
  end if;
  jt  := nullif(left(btrim(coalesce(p_profile ->> 'job_title', '')), 32), '');
  if need_name and (nm = '' or length(nm) > 24 or aff = '' or length(aff) > 32) then
    raise exception 'フルネームと所属を入力してください。' using errcode = 'P0001', hint = 'name_required';
  end if;

  -- 回答（会の質問にある prompt だけ。同じ prompt は1回。本文 1〜60 字。形が違うものは数えない）
  q_count := jsonb_array_length(ev.questions);
  need_ans := case when is_mem then 0 else least(2, q_count) end;
  for a in select x from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) x loop
    pr := a ->> 'prompt';
    bd := btrim(coalesce(a ->> 'body', ''));
    if pr is null or pr = any (seen) or length(bd) not between 1 and 60
       or not exists (select 1 from jsonb_array_elements(ev.questions) q where q ->> 'prompt' = pr)
       or a -> 'vec' is null or a -> 'vec_c' is null or a -> 'x' is null or a -> 'y' is null
       or a -> 'cluster_id' is null then
      continue;
    end if;
    seen := seen || pr;
    valid_ans := valid_ans || jsonb_build_array(a);
  end loop;
  if jsonb_array_length(valid_ans) < need_ans then
    raise exception '質問は2つ以上答えてください。' using errcode = 'P0001', hint = 'answers_required';
  end if;

  -- 申し込みの行（accounts より先。accounts_invite_guard を通すため）
  if reg.event_id is null then
    insert into public.event_registrations
      (event_id, account_id, status, consent_version, was_guest, created_account, channel, referral)
    values (p_event, p_account, 'applied', consent, not is_mem, not acct_exists, p_channel, ref);
    created := not acct_exists;
  else
    update public.event_registrations
       set status = 'applied', consent_version = coalesce(consent, consent_version), was_guest = not is_mem,
           channel = p_channel, referral = ref, applied_at = now(),
           cancelled_at = null, late_minutes = null, late_at = null
     where event_id = p_event and account_id = p_account;
    created := reg.created_account;
  end if;

  -- accounts（無ければ作る。フルネームの確認がまだなら名前を入れる。年代・職種は空のときだけ入れる）
  if not acct_exists then
    insert into public.accounts (id, display_name, affiliation, age_band, job_title, name_confirmed_at, created_via)
    values (p_account, nm, aff, ab, jt, now(), 'event');
  elsif confirmed is null then
    update public.accounts
       set display_name = nm, affiliation = aff, name_confirmed_at = now(),
           age_band = coalesce(ab, age_band), job_title = coalesce(jt, job_title)
     where id = p_account;
  elsif ab is not null or jt is not null then
    update public.accounts
       set age_band = coalesce(age_band, ab), job_title = coalesce(job_title, jt)
     where id = p_account;
  end if;

  -- join（定員・期限は reactions_recruit_guard が見る。主催者への「参加」通知は on_reaction_change が出す）
  insert into public.reactions (post_id, actor_id, kind) values (p_event, p_account, 'join')
  on conflict do nothing;

  -- 回答（取り消し前の古い回答は消して入れ直す）
  delete from public.event_answers where event_id = p_event and account_id = p_account;
  insert into public.event_answers (event_id, account_id, prompt, body, vec, vec_c, x, y, cluster_id, terms)
  select p_event, p_account, v ->> 'prompt', btrim(v ->> 'body'),
         (v ->> 'vec')::vector(448), (v ->> 'vec_c')::vector(448),
         (v ->> 'x')::double precision, (v ->> 'y')::double precision, (v ->> 'cluster_id')::smallint,
         coalesce(v -> 'terms', '[]'::jsonb)
    from jsonb_array_elements(valid_ans) v;

  -- 案内の予定（LINE で申し込んだ人だけ）
  if p_channel = 'line' then
    perform public.event_queue_reminders(p_event, p_account);
  end if;

  select p.recruit_capacity - p.join_count into remaining from public.posts p where p.id = p_event;
  return jsonb_build_object('status', 'applied', 'is_member', is_mem, 'was_guest', not is_mem,
                            'created_account', created, 'remaining', remaining);
end $$;

-- 申し込みを取り消す。applied だけ（受付のあとは event_attended）。waiting（受付待ち）の本人の取り下げも cancelled にする
-- （行を消さず walkin_rejects を残す＝やり直し3回の数えを消さないため）。
-- join を消す、未送信の予定を消す、受付前の回答を消す、主催者へ event_cancel を入れる。
create or replace function public.event_cancel_registration(p_event uuid, p_account uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ev  public.events%rowtype;
  po  record;
  reg public.event_registrations%rowtype;
begin
  select e.* into ev from public.events e where e.post_id = p_event;
  if not found then
    raise exception 'この会は見つかりません。' using errcode = 'P0001', hint = 'event_not_found';
  end if;
  select r.* into reg from public.event_registrations r
   where r.event_id = p_event and r.account_id = p_account for update;
  if not found or reg.status not in ('applied', 'waiting', 'attended') then
    raise exception 'この会に申し込んでいません。' using errcode = 'P0001', hint = 'event_not_applied';
  end if;
  if reg.status = 'attended' then
    raise exception '受付のあとは、取り消せません。' using errcode = 'P0001', hint = 'event_attended';
  end if;
  select p.author_id into po from public.posts p where p.id = p_event;
  update public.event_registrations
     set status = 'cancelled', cancelled_at = now()
   where event_id = p_event and account_id = p_account;
  delete from public.reactions
   where post_id = p_event and actor_id = p_account and kind = 'join';
  delete from public.outbound_messages where event_id = p_event and account_id = p_account and sent_at is null;
  delete from public.event_answers where event_id = p_event and account_id = p_account;
  if reg.status = 'applied' and po.author_id is not null and po.author_id <> p_account
     and exists (select 1 from public.accounts a where a.id = p_account) then
    insert into public.notifications (recipient_id, actor_id, post_id, type, community_id, payload)
    values (po.author_id, p_account, p_event, 'event_cancel', ev.community_id, '{}'::jsonb);
  end if;
  return jsonb_build_object('status', 'cancelled');
end $$;

-- 遅れる連絡（10 / 30 / 60 分）。applied のときだけ。主催者へ event_late。同じ人の古い未読の event_late は消す。
create or replace function public.event_set_late(p_event uuid, p_account uuid, p_minutes integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ev  public.events%rowtype;
  reg public.event_registrations%rowtype;
  po  record;
begin
  select e.* into ev from public.events e where e.post_id = p_event;
  if not found then
    raise exception 'この会は見つかりません。' using errcode = 'P0001', hint = 'event_not_found';
  end if;
  if ev.cancelled_at is not null then
    raise exception 'この会は中止になりました。' using errcode = 'P0001', hint = 'event_cancelled';
  end if;
  select r.* into reg from public.event_registrations r
   where r.event_id = p_event and r.account_id = p_account for update;
  if not found or reg.status <> 'applied' then
    raise exception 'この会に申し込んでいません。' using errcode = 'P0001', hint = 'event_not_applied';
  end if;
  update public.event_registrations
     set late_minutes = p_minutes::smallint, late_at = now()
   where event_id = p_event and account_id = p_account;   -- 10 / 30 / 60 以外は check（23514）で止まる
  select p.author_id into po from public.posts p where p.id = p_event;
  if po.author_id is not null and po.author_id <> p_account then
    delete from public.notifications n
     where n.type = 'event_late' and n.post_id = p_event and n.actor_id = p_account and n.read_at is null;
    insert into public.notifications (recipient_id, actor_id, post_id, type, community_id, payload)
    values (po.author_id, p_account, p_event, 'event_late', ev.community_id,
            jsonb_build_object('minutes', p_minutes));
  end if;
  return jsonb_build_object('late_minutes', p_minutes);
end $$;

-- お断り（主催者だけ）。declined にして、join を消し、未送信の予定を消し、LINE で申し込んだ人には declined を今すぐ送る形で入れる。
-- 受付済みの人は断れない（event_attended）。もう断っていたら何もせず declined を返す。
create or replace function public.event_decline(p_event uuid, p_host uuid, p_account uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ev  public.events%rowtype;
  po  record;
  reg public.event_registrations%rowtype;
begin
  select e.* into ev from public.events e where e.post_id = p_event;
  if not found then
    raise exception 'この会は見つかりません。' using errcode = 'P0001', hint = 'event_not_found';
  end if;
  select p.author_id into po from public.posts p where p.id = p_event;
  if po.author_id is distinct from p_host then
    raise exception 'この会の主催者だけが行えます。' using errcode = 'P0001', hint = 'event_not_host';
  end if;
  select r.* into reg from public.event_registrations r
   where r.event_id = p_event and r.account_id = p_account for update;
  if not found then
    raise exception 'この会に申し込んでいません。' using errcode = 'P0001', hint = 'event_not_applied';
  end if;
  if reg.status = 'declined' then
    return jsonb_build_object('status', 'declined');
  end if;
  if reg.status = 'attended' then
    raise exception '受付のあとは、取り消せません。' using errcode = 'P0001', hint = 'event_attended';
  end if;
  update public.event_registrations
     set status = 'declined', declined_at = now(),
         declined_by = (select a.id from public.accounts a where a.id = p_host)
   where event_id = p_event and account_id = p_account;
  delete from public.reactions
   where post_id = p_event and actor_id = p_account and kind = 'join';
  delete from public.outbound_messages where event_id = p_event and account_id = p_account and sent_at is null;
  delete from public.event_answers where event_id = p_event and account_id = p_account;
  if reg.channel = 'line' then
    insert into public.outbound_messages (event_id, account_id, kind, scheduled_at)
    values (p_event, p_account, 'declined', now())
    on conflict (event_id, account_id, kind) do update
      set scheduled_at = now(), sent_at = null, claimed_at = null, attempts = 0, last_error = null;
  end if;
  return jsonb_build_object('status', 'declined');
end $$;

-- ===========================================================================
-- 9. サーバーの関数（②）: 読み取り・LINE・予約送信・probe
-- ===========================================================================
-- 受付前の回答（地図の近い人の計算用）。vec_c は pgvector の文字列。
create or replace function public.event_answer_vectors(p_event uuid)
returns table (account_id uuid, prompt text, body text, vec_c text,
               x double precision, y double precision, cluster_id smallint)
language sql stable security definer set search_path = public as $$
  select a.account_id, a.prompt, a.body, a.vec_c::text, a.x, a.y, a.cluster_id
    from public.event_answers a
   where a.event_id = p_event
   order by a.created_at, a.account_id, a.prompt
$$;

-- 自分の申し込みの一覧（LINE のメニュー・マイページ用）。中止された会も cancelled_at 付きで返す。
create or replace function public.my_event_registrations(p_account uuid)
returns table (event_id uuid, status text, public_code text, title text,
               starts_at timestamptz, ends_at timestamptz, cancelled_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.event_id, r.status, e.public_code, e.title, e.starts_at, e.ends_at, e.cancelled_at
    from public.event_registrations r
    join public.events e on e.post_id = r.event_id
   where r.account_id = p_account
   order by e.starts_at desc, r.event_id
$$;

-- LINE ログイン（custom:line）の sub から、アカウントの id を引く。見つからなければ null。
-- 未確認: identity_data のキー名は 'sub'（本番の前に、検証用のチャネルで確かめる。D の 7 章 23）。
create or replace function public.account_by_line_sub(p_sub text)
returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid;
begin
  if p_sub is null or p_sub = '' then
    return null;
  end if;
  select i.user_id into uid
    from auth.identities i
   where i.provider = 'custom:line' and i.identity_data ->> 'sub' = p_sub
   limit 1;
  return uid;
end $$;

-- LINE の結びつけを保存（アカウントごとに1つ。同じ LINE の人が別のアカウントに付いていたら、そちらを外す）。
-- p_account が null（follow の時点でアカウントが見つからない）のときは、結びつけずに line_pending_friends へ
-- userId と友だちの状態だけ記録する（あとで line_link_attach が結びつける）。
create or replace function public.line_link_save(p_account uuid, p_line_user_id text, p_is_friend boolean)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_account is null then
    insert into public.line_pending_friends (line_user_id, is_friend, followed_at, unfollowed_at)
    values (p_line_user_id, coalesce(p_is_friend, true),
            case when coalesce(p_is_friend, true) then now() end,
            case when not coalesce(p_is_friend, true) then now() end)
    on conflict (line_user_id) do update
      set is_friend     = excluded.is_friend,
          followed_at   = case when excluded.is_friend and not public.line_pending_friends.is_friend then now()
                               else public.line_pending_friends.followed_at end,
          unfollowed_at = case when not excluded.is_friend and public.line_pending_friends.is_friend then now()
                               when excluded.is_friend then null
                               else public.line_pending_friends.unfollowed_at end,
          updated_at    = now();
    return;
  end if;
  delete from public.line_links l where l.line_user_id = p_line_user_id and l.account_id <> p_account;
  delete from public.line_pending_friends f where f.line_user_id = p_line_user_id;
  insert into public.line_links (account_id, line_user_id, is_friend, followed_at, unfollowed_at)
  values (p_account, p_line_user_id, coalesce(p_is_friend, true),
          case when coalesce(p_is_friend, true) then now() end,
          case when not coalesce(p_is_friend, true) then now() end)
  on conflict (account_id) do update
    set line_user_id  = excluded.line_user_id,
        is_friend     = excluded.is_friend,
        followed_at   = case when excluded.is_friend and (not public.line_links.is_friend
                                                          or public.line_links.line_user_id <> excluded.line_user_id
                                                          or public.line_links.followed_at is null)
                             then now() else public.line_links.followed_at end,
        unfollowed_at = case when excluded.is_friend then null
                             when public.line_links.is_friend then now()
                             else public.line_links.unfollowed_at end;
end $$;

-- 先に友だち追加していた人を、アカウントに結びつける（申し込み・ログインで LINE の sub＝userId が分かったとき）。
-- is_friend は line_pending_friends の記録を使う。記録が無ければ、同じ userId で結びついている行の状態、
-- それも無ければ false（友だちかどうか分からない。次の follow で true になる）。
-- 結びついたら line_pending_friends の行は消す。返り値は結びついたあとの is_friend。
create or replace function public.line_link_attach(p_account uuid, p_line_user_id text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  pend public.line_pending_friends%rowtype;
  cur  public.line_links%rowtype;
  fr   boolean;
begin
  if p_account is null or p_line_user_id is null or p_line_user_id = '' then
    return false;
  end if;
  select f.* into pend from public.line_pending_friends f where f.line_user_id = p_line_user_id for update;
  select l.* into cur from public.line_links l where l.account_id = p_account;
  fr := case when pend.line_user_id is not null then pend.is_friend
             when cur.account_id is not null and cur.line_user_id = p_line_user_id then cur.is_friend
             else false end;
  delete from public.line_links l where l.line_user_id = p_line_user_id and l.account_id <> p_account;
  delete from public.line_pending_friends f where f.line_user_id = p_line_user_id;
  insert into public.line_links (account_id, line_user_id, is_friend, followed_at, unfollowed_at)
  values (p_account, p_line_user_id, fr,
          case when fr then coalesce(pend.followed_at, cur.followed_at, now()) end,
          case when not fr then coalesce(pend.unfollowed_at, cur.unfollowed_at) end)
  on conflict (account_id) do update
    set line_user_id = excluded.line_user_id, is_friend = excluded.is_friend,
        followed_at = excluded.followed_at, unfollowed_at = excluded.unfollowed_at;
  return fr;
end $$;

-- 友だちをやめた（ブロックした）。結びついていない人は line_pending_friends の記録を直す。
create or replace function public.line_link_unfollow(p_line_user_id text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.line_links
     set is_friend = false, unfollowed_at = now()
   where line_user_id = p_line_user_id and is_friend;
  if not exists (select 1 from public.line_links l where l.line_user_id = p_line_user_id) then
    insert into public.line_pending_friends (line_user_id, is_friend, unfollowed_at)
    values (p_line_user_id, false, now())
    on conflict (line_user_id) do update
      set is_friend = false, unfollowed_at = now(), updated_at = now();
  end if;
end $$;

-- webhook の二重受け取りを防ぐ。初めてなら true、すでに受け取っていたら false。
create or replace function public.line_webhook_seen(p_id text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  if p_id is null or p_id = '' then
    return true;
  end if;
  insert into public.line_webhook_events (webhook_event_id) values (p_id) on conflict do nothing;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- 送る予定を取り出す（二重取りなし）。時刻が来ていて、未送信で、貸し出し中でなく（claimed_at が無いか、
-- p_lease_seconds より前）、5回未満の試行で、予定から24時間以内で、友だちの人の行だけ。
-- for update skip locked で取り、claimed_at を今にして attempts を1増やす。
drop function if exists public.outbound_claim(integer, integer);
create function public.outbound_claim(p_limit integer default 50, p_lease_seconds integer default 300)
returns table (id uuid, event_id uuid, account_id uuid, kind text, line_user_id text, title text,
               starts_at timestamptz, ends_at timestamptz, place text, public_code text, near_count integer)
language sql volatile security definer set search_path = public as $$
  with picked as (
    select o.id
      from public.outbound_messages o
      join public.line_links l on l.account_id = o.account_id and l.is_friend
     where o.sent_at is null
       and o.scheduled_at <= now()
       and o.scheduled_at > now() - interval '24 hours'
       and o.attempts < 5
       and (o.claimed_at is null or o.claimed_at < now() - make_interval(secs => greatest(p_lease_seconds, 0)))
     order by o.scheduled_at, o.id
     limit greatest(p_limit, 0)
       for update of o skip locked
  ), upd as (
    update public.outbound_messages o
       set claimed_at = now(), attempts = o.attempts + 1
      from picked
     where o.id = picked.id
    returning o.id, o.event_id, o.account_id, o.kind
  )
  select u.id, u.event_id, u.account_id, u.kind, l.line_user_id, e.title, e.starts_at, e.ends_at, e.place, e.public_code,
         null::integer   -- near_count（week_before の「近い人が N 人」）。DB では出せないので null。Python が埋める
    from upd u
    join public.line_links l on l.account_id = u.account_id
    join public.events e on e.post_id = u.event_id
$$;

-- 送れた／送れなかった。成功は sent_at。失敗は last_error（貸し出しの時刻はそのまま＝次の取り出しまで待つ）。
create or replace function public.outbound_done(p_id uuid, p_ok boolean, p_error text default null)
returns void
language sql security definer set search_path = public as $$
  update public.outbound_messages
     set sent_at    = case when coalesce(p_ok, false) then now() else sent_at end,
         last_error = case when coalesce(p_ok, false) then null else left(p_error, 500) end
   where id = p_id
$$;

-- 「近い人が来るか見てみる」の回数の数え。同じ cookie・同じ IP は1つの会につき1日 p_limit 回（既定5）、
-- 会全体で1日 p_total 回（既定300）。日は日本時間。上限を超えるときは数えずに ok=false を返す。
-- IP は md5 にして 'ip:' を付けて持つ。記録は翌日には消す（片付け）。
-- 返り値 {"ok": boolean, "remaining": その人があと何回できるか}。
create or replace function public.event_probe_hit(
  p_event uuid, p_device text, p_ip text, p_limit integer default 5, p_total integer default 300
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  today  date := (now() at time zone 'Asia/Tokyo')::date;
  dev    text := coalesce(nullif(p_device, ''), '-');
  ipk    text := 'ip:' || md5(coalesce(p_ip, ''));
  n_dev  integer;
  n_ip   integer;
  n_all  integer;
  left_n integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('probe:' || p_event::text, 0));
  select coalesce(max(h.n) filter (where h.device = dev), 0),
         coalesce(max(h.n) filter (where h.device = ipk), 0),
         coalesce(max(h.n) filter (where h.device = '*'), 0)
    into n_dev, n_ip, n_all
    from public.event_probe_hits h
   where h.event_id = p_event and h.day = today;
  if n_dev >= p_limit or n_ip >= p_limit or n_all >= p_total then
    return jsonb_build_object('ok', false, 'remaining', 0);
  end if;
  insert into public.event_probe_hits (event_id, device, day, n)
  values (p_event, dev, today, 1), (p_event, ipk, today, 1), (p_event, '*', today, 1)
  on conflict (event_id, device, day) do update set n = public.event_probe_hits.n + 1;
  left_n := least(p_limit - n_dev - 1, p_limit - n_ip - 1);
  return jsonb_build_object('ok', true, 'remaining', greatest(left_n, 0));
end $$;

-- ===========================================================================
-- 10. 権限（必ず先に revoke。Supabase は新しい関数に全員の実行権を自動で付けるため）
-- ===========================================================================
-- ②の関数は service_role だけ。ブラウザ（anon・authenticated）は呼べない。
revoke all on function public.event_create(uuid, uuid, text, timestamptz, timestamptz, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.event_update(uuid, uuid, jsonb)                          from public, anon, authenticated;
revoke all on function public.event_apply(uuid, uuid, jsonb, text, text, jsonb, text)  from public, anon, authenticated;
revoke all on function public.event_cancel_registration(uuid, uuid)                    from public, anon, authenticated;
revoke all on function public.event_set_late(uuid, uuid, integer)                      from public, anon, authenticated;
revoke all on function public.event_decline(uuid, uuid, uuid)                          from public, anon, authenticated;
revoke all on function public.event_answer_vectors(uuid)                               from public, anon, authenticated;
revoke all on function public.account_by_line_sub(text)                                from public, anon, authenticated;
revoke all on function public.line_link_save(uuid, text, boolean)                      from public, anon, authenticated;
revoke all on function public.line_link_attach(uuid, text)                             from public, anon, authenticated;
revoke all on function public.my_event_registrations(uuid)                             from public, anon, authenticated;
revoke all on function public.line_link_unfollow(text)                                 from public, anon, authenticated;
revoke all on function public.line_webhook_seen(text)                                  from public, anon, authenticated;
revoke all on function public.outbound_claim(integer, integer)                         from public, anon, authenticated;
revoke all on function public.outbound_done(uuid, boolean, text)                       from public, anon, authenticated;
revoke all on function public.event_probe_hit(uuid, text, text, integer, integer)      from public, anon, authenticated;
grant execute on function public.event_create(uuid, uuid, text, timestamptz, timestamptz, text, text, jsonb) to service_role;
grant execute on function public.event_update(uuid, uuid, jsonb)                          to service_role;
grant execute on function public.event_apply(uuid, uuid, jsonb, text, text, jsonb, text)  to service_role;
grant execute on function public.event_cancel_registration(uuid, uuid)                    to service_role;
grant execute on function public.event_set_late(uuid, uuid, integer)                      to service_role;
grant execute on function public.event_decline(uuid, uuid, uuid)                          to service_role;
grant execute on function public.event_answer_vectors(uuid)                               to service_role;
grant execute on function public.account_by_line_sub(text)                                to service_role;
grant execute on function public.line_link_save(uuid, text, boolean)                      to service_role;
grant execute on function public.line_link_attach(uuid, text)                             to service_role;
grant execute on function public.my_event_registrations(uuid)                             to service_role;
grant execute on function public.line_link_unfollow(text)                                 to service_role;
grant execute on function public.line_webhook_seen(text)                                  to service_role;
grant execute on function public.outbound_claim(integer, integer)                         to service_role;
grant execute on function public.outbound_done(uuid, boolean, text)                       to service_role;
grant execute on function public.event_probe_hit(uuid, text, text, integer, integer)      to service_role;

commit;
