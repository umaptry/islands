-- 2026-11-11: 会の開催条件（最小開催人数・判定日・キャンセル期限・会のあとの入り方）と第2回b（受付・飛び入り・
-- 参加者リスト・会えてよかった）。M4。
--
-- 設計: 設計_イベント申し込み G（第1部「相談役のレビューを受けて直したこと」・第2部「共通」「DB（M4）」。C・D と食い違うときは G）、
--       C（2-5〜2-9）、D（1 章の決まり）。
-- 流す順番: M3（20261106000000_events.sql）→ この M4。
--
--   * events に列  min_participants（最小開催人数）/ decide_on（判定日。JST の日付。その日の終わりまで）/
--                  cancel_deadline（キャンセル期限）/ join_policy（会のあとの入り方 auto・ask・none。既存の会は auto）/
--                  decision・decided_at（開催決定 held／中止 not_held の記録）。
--   * 判定（settle）  最小人数に届いたら held を記録（固定。そのあと減っても held）。届かないまま判定日の翌0時（JST）を
--                  過ぎたら not_held を記録し、その会の未送信の予定を消す。書き込みの関数は最初に判定を呼ぶ。
--   * 関数（サーバーだけ。service_role）  event_settle / event_settle_due / event_checkin / event_walkin_request /
--                  event_checkin_by_host / event_reject_walkin / event_join_community / event_participants /
--                  event_participant_answers / event_after_people / event_meet。
--   * 関数（中だけ）  event_live_count / event_admit / event_after_attend。
--   * 作り直し      event_create（引数を4つ足した形1つ。古い8引数の形は消す）/ event_update / event_apply /
--                  event_cancel_registration / event_set_late / event_queue_reminders / outbound_claim。
--   * 名簿（event_roster）は作らない（Python が表を直接読んでいる。G 第1部）。
--
-- 古いコード（第2回a の main）のまま先に流しても壊れない: 今のコードが呼ぶ関数の引数名・返り値の形は変えない
-- （増やすのは既定値つきの引数と、返す jsonb の新しいキーだけ）。既存の会は join_policy = auto・最小人数なしなので、
-- 判定は何もしない（今までどおり）。
--
-- 足す・作り直すだけで、何度流しても壊れない。1本 = 1 transaction。
-- 戻すときは supabase/rollback/20261111000000_events_b_rollback.sql（コードを先に戻してから）。
begin;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- ===========================================================================
-- 1. events の列
-- ===========================================================================
-- min_participants と decide_on は組（両方あるか両方ないか）。判定日・期限と開始日時の前後は関数で確かめる
-- （表の check にしない: 「今日以降」は時刻で変わるため）。
alter table public.events add column if not exists min_participants smallint
  check (min_participants between 2 and 1000);
alter table public.events add column if not exists decide_on date;
alter table public.events add column if not exists cancel_deadline timestamptz;
alter table public.events add column if not exists join_policy text not null default 'auto'
  check (join_policy in ('auto', 'ask', 'none'));
alter table public.events add column if not exists decision text
  check (decision in ('held', 'not_held'));
alter table public.events add column if not exists decided_at timestamptz;
alter table public.events drop constraint if exists events_min_decide_pair;
alter table public.events add constraint events_min_decide_pair
  check ((min_participants is null) = (decide_on is null));
-- 判定がまだの会を毎分探す（event_settle_due）
create index if not exists events_undecided_idx on public.events (decide_on)
  where min_participants is not null and decision is null and cancelled_at is null;

-- ===========================================================================
-- 2. 中だけの関数
-- ===========================================================================
-- 生きている申し込みの数（applied・attended）。主催者は申し込んでいなければ数えない。
create or replace function public.event_live_count(p_event uuid)
returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::integer
    from public.event_registrations r
   where r.event_id = p_event and r.status in ('applied', 'attended')
$$;
revoke all on function public.event_live_count(uuid) from public, anon, authenticated;

-- コミュニティに入れる（受付の自動加入・「このコミュニティに参加する」）。外された・断られた記録があれば入れず false。
-- もうメンバーなら何もせず false。入れたら true:
--   * community_members に role = member、joined_via = 'event'、event_post_id = この会
--   * そのコミュニティへの承認待ち（pending）と、その通知・お知らせの記録を消す（claim_invite の「入った」ときと同じ）
--   * 申し込みの回答（event_answers）を、このコミュニティの投稿として posts に写す（回答は消さない。参加者リストが使い、
--     会の7日後の片付けで消える）。写すのが失敗しても（地図の保守中など）、入ることは止めない。
-- 新しい住人の通知・島の作り直しは Python が行う（DB のトリガーは無い）。
create or replace function public.event_admit(p_event uuid, p_account uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  ev    public.events%rowtype;
  added integer;
begin
  select e.* into ev from public.events e where e.post_id = p_event;
  if not found or p_account is null then
    return false;
  end if;
  if exists (select 1 from public.community_removals x
              where x.community_id = ev.community_id and x.account_id = p_account)
     or exists (select 1 from public.community_join_requests q
                 where q.community_id = ev.community_id and q.account_id = p_account and q.status = 'rejected') then
    return false;
  end if;
  insert into public.community_members (community_id, account_id, role, joined_via, event_post_id)
  values (ev.community_id, p_account, 'member', 'event', p_event)
  on conflict (community_id, account_id) do nothing;
  get diagnostics added = row_count;
  if added = 0 then
    return false;
  end if;
  delete from public.community_join_requests q
   where q.community_id = ev.community_id and q.account_id = p_account and q.status = 'pending';
  delete from public.notifications n
   where n.type = 'join_request' and n.actor_id = p_account and n.community_id = ev.community_id;
  delete from public.join_request_notices s where s.community_id = ev.community_id and s.account_id = p_account;
  begin
    insert into public.posts (author_id, body, prompt, x, y, cluster_id, vec, vec_c, terms, community_id)
    select a.account_id, a.body, a.prompt, a.x, a.y, a.cluster_id, a.vec, a.vec_c, a.terms, ev.community_id
      from public.event_answers a
     where a.event_id = p_event and a.account_id = p_account
       and exists (select 1 from public.accounts c where c.id = p_account)
     order by a.created_at, a.prompt;
  exception when others then
    raise warning 'event_admit: 回答を投稿に写せませんでした: %', sqlerrm;
  end;
  return true;
end $$;
revoke all on function public.event_admit(uuid, uuid) from public, anon, authenticated;

-- 受付が済んだあと: 入り方が auto で、まだメンバーでなければ event_admit。入ったか（true）を返す。
-- ask（本人に確認）は event_join_community で、none（加入させない）は入れない。
create or replace function public.event_after_attend(p_event uuid, p_account uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  ev public.events%rowtype;
begin
  select e.* into ev from public.events e where e.post_id = p_event;
  if not found or ev.join_policy <> 'auto' then
    return false;
  end if;
  if exists (select 1 from public.community_members m
              where m.community_id = ev.community_id and m.account_id = p_account) then
    return false;
  end if;
  return public.event_admit(p_event, p_account);
end $$;
revoke all on function public.event_after_attend(uuid, uuid) from public, anon, authenticated;

-- 1人分の案内の予定（M3 の形に「中止（not_held）の会には入れない」を足しただけ）。
create or replace function public.event_queue_reminders(p_event uuid, p_account uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  ev public.events%rowtype;
begin
  select e.* into ev from public.events e where e.post_id = p_event;
  if not found or ev.decision = 'not_held' then
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
-- 3. 判定（②）
-- ===========================================================================
-- 返り値: 最小人数なし → null／記録済み → その値（held・not_held）／届いた → held を記録／
--         判定日の翌0時（JST）を過ぎた → not_held を記録して未送信の予定を消す／それ以外 → recruiting（記録しない）。
-- 中止（cancelled_at）された会は記録しない（recruiting を返す。中止のほうが先に断られる）。
-- 会の行を for update で取ってから判定する（同時に呼ばれても記録は1回）。何度呼んでも同じ。
create or replace function public.event_settle(p_event uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare
  ev public.events%rowtype;
begin
  select e.* into ev from public.events e where e.post_id = p_event for update;
  if not found or ev.min_participants is null then
    return null;
  end if;
  if ev.decision is not null then
    return ev.decision;
  end if;
  if ev.cancelled_at is not null then
    return 'recruiting';
  end if;
  if public.event_live_count(p_event) >= ev.min_participants then
    update public.events set decision = 'held', decided_at = now() where post_id = p_event;
    return 'held';
  end if;
  if now() >= ((ev.decide_on + 1)::timestamp at time zone 'Asia/Tokyo') then
    update public.events set decision = 'not_held', decided_at = now() where post_id = p_event;
    delete from public.outbound_messages o where o.event_id = p_event and o.sent_at is null;
    return 'not_held';
  end if;
  return 'recruiting';
end $$;

-- 毎分の予約送信（jobs.run_tick）から: 最小人数あり・未判定・中止でない・判定の締めを過ぎた会を全部判定する。判定した数。
create or replace function public.event_settle_due()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  r   record;
  n   integer := 0;
  res text;
begin
  for r in select e.post_id from public.events e
            where e.min_participants is not null and e.decision is null and e.cancelled_at is null
              and now() >= ((e.decide_on + 1)::timestamp at time zone 'Asia/Tokyo')
            order by e.decide_on, e.post_id loop
    res := public.event_settle(r.post_id);
    if res in ('held', 'not_held') then
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- ===========================================================================
-- 4. 会を作る・変える（作り直し）
-- ===========================================================================
-- 会を作る。M3 の8引数に、最小開催人数・判定日・キャンセル期限・入り方を足す（どれも既定値つき。今のコードが
-- 8引数で呼んでも、最小人数なし・期限なし・auto で今までどおり作れる）。古い8引数の形は消して、この形1つにする
-- （PostgREST が選ぶ候補を1つに）。
-- 確かめること（足した分）: 最小人数は 2 以上かつ定員（posts.recruit_capacity）以下、最小人数と判定日は両方か両方なし、
-- 判定日は JST の今日以降かつ開始日（JST）より前の日、キャンセル期限は開始より前、入り方は auto・ask・none。
-- 返り値は今のまま {"post_id", "public_code", "checkin_code"}。
drop function if exists public.event_create(uuid, uuid, text, timestamptz, timestamptz, text, text, jsonb);
create or replace function public.event_create(
  p_post uuid, p_actor uuid, p_title text, p_starts timestamptz, p_ends timestamptz,
  p_place text, p_visibility text, p_questions jsonb,
  p_min smallint default null, p_decide_on date default null, p_cancel_deadline timestamptz default null,
  p_join_policy text default 'auto'
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  po    record;
  ev    public.events%rowtype;
  vis   text := coalesce(p_visibility, 'community');
  qs    jsonb := coalesce(p_questions, '[]'::jsonb);
  pol   text := coalesce(p_join_policy, 'auto');
  today date := (now() at time zone 'Asia/Tokyo')::date;
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
     or length(coalesce(p_place, '')) > 60
     -- 開催の条件（M4）
     or pol not in ('auto', 'ask', 'none')
     or (p_min is null) <> (p_decide_on is null)
     or (p_min is not null and (p_min < 2 or p_min > po.recruit_capacity))
     or (p_decide_on is not null
         and (p_decide_on < today or p_decide_on >= (p_starts at time zone 'Asia/Tokyo')::date))
     or (p_cancel_deadline is not null and p_cancel_deadline >= p_starts) then
    raise exception '会の内容を確かめてください。' using errcode = 'P0001', hint = 'event_invalid';
  end if;
  if vis = 'public' and not exists (select 1 from public.community_members m
                                     where m.community_id = po.community_id and m.account_id = p_actor
                                       and m.role = 'admin') then
    raise exception '公開の会は、コミュニティの管理者だけが作れます。' using errcode = 'P0001', hint = 'public_admin_only';
  end if;
  insert into public.events (post_id, community_id, title, starts_at, ends_at, place, visibility, questions,
                             public_code, checkin_code, min_participants, decide_on, cancel_deadline, join_policy)
  values (p_post, po.community_id, p_title, p_starts, p_ends, coalesce(p_place, ''), vis, qs,
          public.make_invite_code(), public.make_invite_code(), p_min, p_decide_on, p_cancel_deadline, pol)
  returning * into ev;
  return jsonb_build_object('post_id', ev.post_id, 'public_code', ev.public_code, 'checkin_code', ev.checkin_code);
end $$;

-- 会を変える。p_fields のキー: title / starts_at / ends_at / place / questions に、M4 で
-- min_participants / decide_on（"YYYY-MM-DD"）/ cancel_deadline / join_policy を足す（入っているものだけ変える。
-- null を送ればその設定を消す。min_participants と decide_on は組で）。
--   * 判定（decision）が出たあとは、最小人数・判定日を変えようとすると event_decided（同じ値なら通す）。
--   * 最小人数は、変えるときだけ 2 以上・定員以下を確かめる。判定日は、変えるときだけ「今日以降」を確かめる。
--   * 判定日は開始日（JST）より前の日、キャンセル期限は開始より前。開始日時を変えたときも比べ直す
--     （判定日は、判定がまだのときだけ。判定のあとは判定日に意味がないため）。
--   * 最初と最後に判定する（最小人数を下げて届いたら、その場で held）。
-- 日時・場所が変わったら、未送信の案内を作り直し、LINE の申し込み中の人へ event_changed を1通入れる（M3 のまま）。
-- 返り値は今のまま {"changed": 何か変わったか, "notified": event_changed を入れた人数}。
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
  n_min    integer;
  n_decide date;
  n_dead   timestamptz;
  n_policy text;
  today    date := (now() at time zone 'Asia/Tokyo')::date;
  v        text;
  when_changed boolean;
  any_changed  boolean;
  r        record;
  notified integer := 0;
begin
  select p.author_id, p.deleted_at, p.recruit_capacity into po from public.posts p where p.id = p_post;
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
  -- 判定（最初）。記録が変わることがあるので読み直す
  perform public.event_settle(p_post);
  select e.* into ev from public.events e where e.post_id = p_post;
  n_title  := case when f ? 'title'     then f ->> 'title'              else ev.title end;
  n_starts := case when f ? 'starts_at' then (f ->> 'starts_at')::timestamptz else ev.starts_at end;
  n_ends   := case when f ? 'ends_at'   then (f ->> 'ends_at')::timestamptz   else ev.ends_at end;
  n_place  := case when f ? 'place'     then coalesce(f ->> 'place', '')  else ev.place end;
  n_qs     := case when f ? 'questions' then f -> 'questions'             else ev.questions end;
  -- 開催の条件（形が違うものは event_invalid）
  begin
    n_min := ev.min_participants;
    if f ? 'min_participants' then
      v := f ->> 'min_participants';
      if v is not null and v !~ '^[0-9]{1,4}$' then
        raise exception 'bad min_participants';
      end if;
      n_min := v::integer;
    end if;
    n_decide := case when f ? 'decide_on'       then (f ->> 'decide_on')::date              else ev.decide_on end;
    n_dead   := case when f ? 'cancel_deadline' then (f ->> 'cancel_deadline')::timestamptz else ev.cancel_deadline end;
  exception when others then
    raise exception '会の内容を確かめてください。' using errcode = 'P0001', hint = 'event_invalid';
  end;
  n_policy := case when f ? 'join_policy' then f ->> 'join_policy' else ev.join_policy end;
  if ev.decision is not null
     and (n_min is distinct from ev.min_participants or n_decide is distinct from ev.decide_on) then
    raise exception '開催の判定が出たあとは、最小開催人数と判定日を変えられません。'
      using errcode = 'P0001', hint = 'event_decided';
  end if;
  if n_title is null or length(n_title) not between 1 and 40
     or n_starts is null or n_ends is null or n_ends <= n_starts
     or length(n_place) > 60
     or not public.event_questions_valid(n_qs)
     -- 開催の条件（M4）
     or n_policy is null or n_policy not in ('auto', 'ask', 'none')
     or (n_min is null) <> (n_decide is null)
     or (n_min is distinct from ev.min_participants and n_min is not null
         and (n_min < 2 or n_min > coalesce(po.recruit_capacity, 0)))
     or (n_decide is distinct from ev.decide_on and n_decide is not null and n_decide < today)
     or (ev.decision is null and n_decide is not null
         and n_decide >= (n_starts at time zone 'Asia/Tokyo')::date)
     or (n_dead is not null and n_dead >= n_starts) then
    raise exception '会の内容を確かめてください。' using errcode = 'P0001', hint = 'event_invalid';
  end if;
  when_changed := n_starts <> ev.starts_at or n_ends <> ev.ends_at or n_place <> ev.place;
  any_changed  := when_changed or n_title <> ev.title or n_qs <> ev.questions
                  or n_min is distinct from ev.min_participants or n_decide is distinct from ev.decide_on
                  or n_dead is distinct from ev.cancel_deadline or n_policy <> ev.join_policy;
  if not any_changed then
    return jsonb_build_object('changed', false, 'notified', 0);
  end if;
  update public.events
     set title = n_title, starts_at = n_starts, ends_at = n_ends, place = n_place, questions = n_qs,
         min_participants = n_min::smallint, decide_on = n_decide, cancel_deadline = n_dead, join_policy = n_policy
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
  -- 判定（最後）
  perform public.event_settle(p_post);
  return jsonb_build_object('changed', true, 'notified', notified);
end $$;

-- ===========================================================================
-- 5. 申し込み・取り消し・遅れる（作り直し）
-- ===========================================================================
-- 申し込む（M3 の形に、判定を足した）。中止の確認のあとで判定し、中止（not_held）なら event_not_held。
-- 最後にもう一度判定する（この申し込みで最小人数に届いたら held）。
-- 返り値に "phase"（held / not_held / recruiting / null＝最小人数なし）を足した。ほかは M3 のまま。
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
  ph          text;
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
  ph := public.event_settle(p_event);
  if ph = 'not_held' then
    raise exception '人数が集まらなかったため、この会は中止になりました。' using errcode = 'P0001', hint = 'event_not_held';
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
                              'remaining', (select p.recruit_capacity - p.join_count from public.posts p where p.id = p_event),
                              'phase', ph);
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

  -- 判定（最後）。この申し込みで最小人数に届いたら held
  ph := public.event_settle(p_event);

  select p.recruit_capacity - p.join_count into remaining from public.posts p where p.id = p_event;
  return jsonb_build_object('status', 'applied', 'is_member', is_mem, 'was_guest', not is_mem,
                            'created_account', created, 'remaining', remaining, 'phase', ph);
end $$;

-- 申し込みを取り消す（M3 の形に足した）。最初に判定する。申し込み中（applied）の取り消しは、
-- キャンセル期限（cancel_deadline）を過ぎていたら cancel_closed。受付待ち（waiting）の取り下げは期限なし。
-- 開催決定（held）のあとに取り消して人数が減っても、決定のまま（判定は記録済みを返すだけ）。
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
  perform public.event_settle(p_event);
  select r.* into reg from public.event_registrations r
   where r.event_id = p_event and r.account_id = p_account for update;
  if not found or reg.status not in ('applied', 'waiting', 'attended') then
    raise exception 'この会に申し込んでいません。' using errcode = 'P0001', hint = 'event_not_applied';
  end if;
  if reg.status = 'attended' then
    raise exception '受付のあとは、取り消せません。' using errcode = 'P0001', hint = 'event_attended';
  end if;
  if reg.status = 'applied' and ev.cancel_deadline is not null and now() >= ev.cancel_deadline then
    raise exception 'キャンセルの期限を過ぎました。期限後のキャンセルは主催者に連絡してください。'
      using errcode = 'P0001', hint = 'cancel_closed';
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

-- 遅れる連絡（M3 の形に、中止（not_held）の会は event_not_held を足した）。
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
  if public.event_settle(p_event) = 'not_held' then
    raise exception '人数が集まらなかったため、この会は中止になりました。' using errcode = 'P0001', hint = 'event_not_held';
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

-- 送る予定を取り出す（M3 の形に、中止（not_held）の会の行は取り出さない、を足した。形は今のまま）。
create or replace function public.outbound_claim(p_limit integer default 50, p_lease_seconds integer default 300)
returns table (id uuid, event_id uuid, account_id uuid, kind text, line_user_id text, title text,
               starts_at timestamptz, ends_at timestamptz, place text, public_code text, near_count integer)
language sql volatile security definer set search_path = public as $$
  with picked as (
    select o.id
      from public.outbound_messages o
      join public.line_links l on l.account_id = o.account_id and l.is_friend
      join public.events ev on ev.post_id = o.event_id
     where o.sent_at is null
       and o.scheduled_at <= now()
       and o.scheduled_at > now() - interval '24 hours'
       and o.attempts < 5
       and (o.claimed_at is null or o.claimed_at < now() - make_interval(secs => greatest(p_lease_seconds, 0)))
       and ev.decision is distinct from 'not_held'
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

-- ===========================================================================
-- 6. 受付（②）
-- ===========================================================================
-- 受付の時間は、開始の3時間前〜終了の2時間後（主催者の受付 event_checkin_by_host は時間を見ない）。

-- QR の受付（本人）。返り値 {"result": "attended"|"already"|"need_walkin"|"waiting", "joined": 今メンバーになったか}。
--   中止 → event_cancelled、not_held → event_not_held、時間外 → checkin_closed、
--   お断り（この会）・外された・断られた（メンバーでない人）→ event_banned。
--   applied → attended（checked_in_at）＋入り方が auto ならメンバーに／attended → already／waiting → waiting／
--   自分で取り消した申し込み（cancelled。飛び入りでない）→ checkin_cancelled_reg／
--   行なし（または飛び入りの却下・取り下げ）: メンバーなら申し込みなしで attended（channel = 'walkin'）、
--   メンバーでなければ need_walkin（画面が名前を聞いて event_walkin_request へ）。
create or replace function public.event_checkin(p_event uuid, p_account uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ev     public.events%rowtype;
  po     record;
  reg    public.event_registrations%rowtype;
  has_reg boolean;
  is_mem boolean;
  joined boolean := false;
begin
  if p_account is null then
    raise exception 'ログインしてください。' using errcode = 'P0001', hint = 'not_logged_in';
  end if;
  select e.* into ev from public.events e where e.post_id = p_event;
  if not found then
    raise exception 'この会は見つかりません。' using errcode = 'P0001', hint = 'event_not_found';
  end if;
  select p.deleted_at into po from public.posts p where p.id = p_event;
  if ev.cancelled_at is not null or po.deleted_at is not null then
    raise exception 'この会は中止になりました。' using errcode = 'P0001', hint = 'event_cancelled';
  end if;
  if public.event_settle(p_event) = 'not_held' then
    raise exception '人数が集まらなかったため、この会は中止になりました。' using errcode = 'P0001', hint = 'event_not_held';
  end if;
  if now() < ev.starts_at - interval '3 hours' or now() > ev.ends_at + interval '2 hours' then
    raise exception '受付の時間ではありません。' using errcode = 'P0001', hint = 'checkin_closed';
  end if;
  is_mem := exists (select 1 from public.community_members m
                     where m.community_id = ev.community_id and m.account_id = p_account);
  select r.* into reg from public.event_registrations r
   where r.event_id = p_event and r.account_id = p_account for update;
  has_reg := found;
  if (has_reg and reg.status = 'declined')
     or (not is_mem and (exists (select 1 from public.community_removals x
                                  where x.community_id = ev.community_id and x.account_id = p_account)
                         or exists (select 1 from public.community_join_requests q
                                     where q.community_id = ev.community_id and q.account_id = p_account
                                       and q.status = 'rejected'))) then
    raise exception 'このコミュニティの会には申し込めません。' using errcode = 'P0001', hint = 'event_banned';
  end if;
  if has_reg and reg.status = 'applied' then
    update public.event_registrations set status = 'attended', checked_in_at = now()
     where event_id = p_event and account_id = p_account;
    joined := public.event_after_attend(p_event, p_account);
    return jsonb_build_object('result', 'attended', 'joined', joined);
  end if;
  if has_reg and reg.status = 'attended' then
    return jsonb_build_object('result', 'already', 'joined', false);
  end if;
  if has_reg and reg.status = 'waiting' then
    return jsonb_build_object('result', 'waiting', 'joined', false);
  end if;
  if has_reg and reg.status = 'cancelled' and reg.channel <> 'walkin' then
    raise exception '申し込みを取り消しています。主催者に声をかけてください。'
      using errcode = 'P0001', hint = 'checkin_cancelled_reg';
  end if;
  -- 行なし、または飛び入りの却下・取り下げ（cancelled・walkin）
  if is_mem then
    if has_reg then
      update public.event_registrations
         set status = 'attended', checked_in_at = now(), cancelled_at = null
       where event_id = p_event and account_id = p_account;
    else
      insert into public.event_registrations
        (event_id, account_id, status, was_guest, created_account, channel, checked_in_at)
      values (p_event, p_account, 'attended', false, false, 'walkin', now());
    end if;
    return jsonb_build_object('result', 'attended', 'joined', false);
  end if;
  return jsonb_build_object('result', 'need_walkin', 'joined', false);
end $$;

-- 飛び入りの受付待ち（本人）。返り値 {"status": "waiting"}（申し込み中・受付済みならその状態を返すだけ）。
--   時間外・中止・not_held・お断り（この会）・外された・断られた（メンバーでない人）は断る。
--   却下が3回たまったら walkin_limit。
--   p_profile: {"display_name","affiliation","age_band","job_title"}。accounts が無い人、または name_confirmed_at が
--              無い人は display_name（1〜24字）と affiliation（1〜32字）が要る（name_required。event_apply と同じ）。
--   行が無ければ status = 'waiting'、channel = 'walkin' の行を作る。取り消し・却下で cancelled の行なら waiting に戻す。
--   accounts が無ければ作る（created_account = true、created_via = 'event'）。
create or replace function public.event_walkin_request(p_event uuid, p_account uuid, p_profile jsonb, p_consent text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ev          public.events%rowtype;
  po          record;
  reg         public.event_registrations%rowtype;
  has_reg     boolean;
  is_mem      boolean;
  acct_exists boolean;
  confirmed   timestamptz;
  need_name   boolean;
  nm          text;
  aff         text;
  ab          text;
  jt          text;
  consent     text := nullif(left(btrim(coalesce(p_consent, '')), 32), '');
begin
  if p_account is null then
    raise exception 'ログインしてください。' using errcode = 'P0001', hint = 'not_logged_in';
  end if;
  select e.* into ev from public.events e where e.post_id = p_event;
  if not found then
    raise exception 'この会は見つかりません。' using errcode = 'P0001', hint = 'event_not_found';
  end if;
  select p.deleted_at into po from public.posts p where p.id = p_event;
  if ev.cancelled_at is not null or po.deleted_at is not null then
    raise exception 'この会は中止になりました。' using errcode = 'P0001', hint = 'event_cancelled';
  end if;
  if public.event_settle(p_event) = 'not_held' then
    raise exception '人数が集まらなかったため、この会は中止になりました。' using errcode = 'P0001', hint = 'event_not_held';
  end if;
  if now() < ev.starts_at - interval '3 hours' or now() > ev.ends_at + interval '2 hours' then
    raise exception '受付の時間ではありません。' using errcode = 'P0001', hint = 'checkin_closed';
  end if;
  is_mem := exists (select 1 from public.community_members m
                     where m.community_id = ev.community_id and m.account_id = p_account);
  select r.* into reg from public.event_registrations r
   where r.event_id = p_event and r.account_id = p_account for update;
  has_reg := found;
  if (has_reg and reg.status = 'declined')
     or (not is_mem and (exists (select 1 from public.community_removals x
                                  where x.community_id = ev.community_id and x.account_id = p_account)
                         or exists (select 1 from public.community_join_requests q
                                     where q.community_id = ev.community_id and q.account_id = p_account
                                       and q.status = 'rejected'))) then
    raise exception 'このコミュニティの会には申し込めません。' using errcode = 'P0001', hint = 'event_banned';
  end if;
  if has_reg and reg.status in ('applied', 'attended', 'waiting') then
    return jsonb_build_object('status', reg.status);
  end if;
  if has_reg and reg.walkin_rejects >= 3 then
    raise exception '受付できませんでした。主催者に声をかけてください。' using errcode = 'P0001', hint = 'walkin_limit';
  end if;

  -- 名前（event_apply と同じ）
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

  -- 受付待ちの行（accounts より先。accounts_invite_guard を通すため）
  if not has_reg then
    insert into public.event_registrations
      (event_id, account_id, status, consent_version, was_guest, created_account, channel)
    values (p_event, p_account, 'waiting', consent, not is_mem, not acct_exists, 'walkin');
  else
    update public.event_registrations
       set status = 'waiting', consent_version = coalesce(consent, consent_version), was_guest = not is_mem,
           applied_at = now(), cancelled_at = null
     where event_id = p_event and account_id = p_account;
  end if;

  -- accounts（event_apply と同じ）
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
  return jsonb_build_object('status', 'waiting');
end $$;

-- 主催者の受付（名簿の「受付する」）。返り値 {"status": "attended", "joined": 今メンバーになったか}。
-- 主催者（会の投稿の作者）だけ。受付待ち（waiting）か申し込み中（applied）の行だけ（ほかは not_waiting）。
-- 受付の時間は見ない（主催者の判断）。中止・not_held は断る。
create or replace function public.event_checkin_by_host(p_event uuid, p_host uuid, p_account uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ev     public.events%rowtype;
  po     record;
  reg    public.event_registrations%rowtype;
  joined boolean;
begin
  select e.* into ev from public.events e where e.post_id = p_event;
  if not found then
    raise exception 'この会は見つかりません。' using errcode = 'P0001', hint = 'event_not_found';
  end if;
  select p.author_id, p.deleted_at into po from public.posts p where p.id = p_event;
  if po.author_id is distinct from p_host then
    raise exception 'この会の主催者だけが行えます。' using errcode = 'P0001', hint = 'event_not_host';
  end if;
  if ev.cancelled_at is not null or po.deleted_at is not null then
    raise exception 'この会は中止になりました。' using errcode = 'P0001', hint = 'event_cancelled';
  end if;
  if public.event_settle(p_event) = 'not_held' then
    raise exception '人数が集まらなかったため、この会は中止になりました。' using errcode = 'P0001', hint = 'event_not_held';
  end if;
  select r.* into reg from public.event_registrations r
   where r.event_id = p_event and r.account_id = p_account for update;
  if not found or reg.status not in ('waiting', 'applied') then
    raise exception '受付待ちではありません。' using errcode = 'P0001', hint = 'not_waiting';
  end if;
  update public.event_registrations
     set status = 'attended', checked_in_at = now(), cancelled_at = null
   where event_id = p_event and account_id = p_account;
  joined := public.event_after_attend(p_event, p_account);
  return jsonb_build_object('status', 'attended', 'joined', joined);
end $$;

-- 主催者の却下（名簿の「却下」）。受付待ち（waiting）だけ。cancelled にして却下の数を1増やす（行は消さない＝
-- やり直し3回の数えを残すため）。返り値 {"walkin_rejects": 却下の数}。
create or replace function public.event_reject_walkin(p_event uuid, p_host uuid, p_account uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  po  record;
  reg public.event_registrations%rowtype;
  n   integer;
begin
  if not exists (select 1 from public.events e where e.post_id = p_event) then
    raise exception 'この会は見つかりません。' using errcode = 'P0001', hint = 'event_not_found';
  end if;
  select p.author_id into po from public.posts p where p.id = p_event;
  if po.author_id is distinct from p_host then
    raise exception 'この会の主催者だけが行えます。' using errcode = 'P0001', hint = 'event_not_host';
  end if;
  select r.* into reg from public.event_registrations r
   where r.event_id = p_event and r.account_id = p_account for update;
  if not found or reg.status <> 'waiting' then
    raise exception '受付待ちではありません。' using errcode = 'P0001', hint = 'not_waiting';
  end if;
  update public.event_registrations
     set status = 'cancelled', cancelled_at = now(), walkin_rejects = least(walkin_rejects + 1, 3)
   where event_id = p_event and account_id = p_account
  returning walkin_rejects into n;
  return jsonb_build_object('walkin_rejects', n);
end $$;

-- 「このコミュニティに参加する」（入り方が ask の会で、受付が済んだ人）。返り値 {"status": "joined"|"already"}。
-- ask でなければ join_not_allowed、受付が済んでいなければ event_not_attended、もうメンバーなら already、
-- 外された・断られた記録があれば event_banned。
create or replace function public.event_join_community(p_event uuid, p_account uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ev public.events%rowtype;
begin
  select e.* into ev from public.events e where e.post_id = p_event;
  if not found then
    raise exception 'この会は見つかりません。' using errcode = 'P0001', hint = 'event_not_found';
  end if;
  if ev.join_policy <> 'ask' then
    raise exception 'この会からは、コミュニティに参加できません。' using errcode = 'P0001', hint = 'join_not_allowed';
  end if;
  if not exists (select 1 from public.event_registrations r
                  where r.event_id = p_event and r.account_id = p_account and r.status = 'attended') then
    raise exception '受付が済んだ人だけが使えます。' using errcode = 'P0001', hint = 'event_not_attended';
  end if;
  if exists (select 1 from public.community_members m
              where m.community_id = ev.community_id and m.account_id = p_account) then
    return jsonb_build_object('status', 'already');
  end if;
  if not public.event_admit(p_event, p_account) then
    raise exception 'このコミュニティの会には申し込めません。' using errcode = 'P0001', hint = 'event_banned';
  end if;
  return jsonb_build_object('status', 'joined');
end $$;

-- ===========================================================================
-- 7. 参加者リスト・会のあと（②）
-- ===========================================================================
-- 参加者リスト: 申し込み中（applied）・受付済み（attended）の人と主催者（申し込みが無ければ status = 'host'）。
-- 年代は返さない。並びは主催者 → 申し込み順（画面の並びは Python が決める）。見てよい人かは Python が確かめる。
create or replace function public.event_participants(p_event uuid)
returns table (account_id uuid, status text, display_name text, affiliation text, job_title text,
               icon_id text, avatar_path text, late_minutes smallint, is_member boolean, is_host boolean,
               checked_in_at timestamptz)
language sql stable security definer set search_path = public as $$
  with ev as (
    select e.post_id, e.community_id, p.author_id
      from public.events e join public.posts p on p.id = e.post_id
     where e.post_id = p_event
  ), people as (
    select r.account_id, r.status, r.late_minutes, r.checked_in_at, r.applied_at
      from public.event_registrations r
     where r.event_id = p_event and r.status in ('applied', 'attended')
    union all
    select ev.author_id, 'host', null::smallint, null::timestamptz, null::timestamptz
      from ev
     where not exists (select 1 from public.event_registrations r
                        where r.event_id = p_event and r.account_id = ev.author_id
                          and r.status in ('applied', 'attended'))
  )
  select pp.account_id, pp.status, a.display_name, a.affiliation, a.job_title, a.icon_id, a.avatar_path,
         pp.late_minutes,
         exists (select 1 from public.community_members m
                  where m.community_id = ev.community_id and m.account_id = pp.account_id),
         pp.account_id = ev.author_id,
         pp.checked_in_at
    from people pp
    cross join ev
    left join public.accounts a on a.id = pp.account_id
   order by (pp.account_id = ev.author_id) desc, pp.applied_at nulls first, pp.account_id
$$;

-- 参加者リストの回答（申し込み中・受付済みの人の event_answers）。会の7日後の片付けで消える。
create or replace function public.event_participant_answers(p_event uuid)
returns table (account_id uuid, prompt text, body text)
language sql stable security definer set search_path = public as $$
  select a.account_id, a.prompt, a.body
    from public.event_answers a
    join public.event_registrations r on r.event_id = a.event_id and r.account_id = a.account_id
   where a.event_id = p_event and r.status in ('applied', 'attended')
   order by a.account_id, a.created_at, a.prompt
$$;

-- 会のあとの一覧: 呼んだ人が受付済み（attended）でなければ event_not_attended。自分以外の受付済みの人。
-- met は「自分 → 相手」の会えてよかった（event_meetings）があるか。
create or replace function public.event_after_people(p_event uuid, p_account uuid)
returns table (account_id uuid, display_name text, affiliation text, job_title text, icon_id text,
               avatar_path text, is_member boolean, met boolean)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  cid uuid;
begin
  select e.community_id into cid from public.events e where e.post_id = p_event;
  if not found then
    raise exception 'この会は見つかりません。' using errcode = 'P0001', hint = 'event_not_found';
  end if;
  if not exists (select 1 from public.event_registrations r
                  where r.event_id = p_event and r.account_id = p_account and r.status = 'attended') then
    raise exception '受付が済んだ人だけが使えます。' using errcode = 'P0001', hint = 'event_not_attended';
  end if;
  return query
    select r.account_id, a.display_name, a.affiliation, a.job_title, a.icon_id, a.avatar_path,
           exists (select 1 from public.community_members m
                    where m.community_id = cid and m.account_id = r.account_id),
           exists (select 1 from public.event_meetings g
                    where g.event_id = p_event and g.from_id = p_account and g.to_id = r.account_id)
      from public.event_registrations r
      join public.accounts a on a.id = r.account_id
     where r.event_id = p_event and r.status = 'attended' and r.account_id <> p_account
     order by r.checked_in_at, r.account_id;
end $$;

-- 会えてよかった（自分 → 相手）。2人とも受付済みでなければ event_not_attended。on なら入れる（あれば何もしない）、
-- off なら消す。返り値 {"on": boolean}。
create or replace function public.event_meet(p_event uuid, p_from uuid, p_to uuid, p_on boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.events e where e.post_id = p_event) then
    raise exception 'この会は見つかりません。' using errcode = 'P0001', hint = 'event_not_found';
  end if;
  if p_from is null or p_to is null or p_from = p_to
     or (select count(*) from public.event_registrations r
          where r.event_id = p_event and r.account_id in (p_from, p_to) and r.status = 'attended') < 2 then
    raise exception '受付が済んだ人だけが使えます。' using errcode = 'P0001', hint = 'event_not_attended';
  end if;
  if coalesce(p_on, false) then
    insert into public.event_meetings (event_id, from_id, to_id) values (p_event, p_from, p_to)
    on conflict do nothing;
  else
    delete from public.event_meetings g where g.event_id = p_event and g.from_id = p_from and g.to_id = p_to;
  end if;
  return jsonb_build_object('on', coalesce(p_on, false));
end $$;

-- ===========================================================================
-- 8. 権限（必ず先に revoke。Supabase は新しい関数に全員の実行権を自動で付けるため）
-- ===========================================================================
-- ②の関数は service_role だけ。③（event_live_count / event_admit / event_after_attend / event_queue_reminders）は
-- 誰にも渡さない（上でそれぞれ revoke 済み）。作り直した関数も、同じ形で付け直す。
revoke all on function public.event_settle(uuid)                                     from public, anon, authenticated;
revoke all on function public.event_settle_due()                                     from public, anon, authenticated;
revoke all on function public.event_create(uuid, uuid, text, timestamptz, timestamptz, text, text, jsonb, smallint, date, timestamptz, text)
                                                                                      from public, anon, authenticated;
revoke all on function public.event_update(uuid, uuid, jsonb)                        from public, anon, authenticated;
revoke all on function public.event_apply(uuid, uuid, jsonb, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.event_cancel_registration(uuid, uuid)                  from public, anon, authenticated;
revoke all on function public.event_set_late(uuid, uuid, integer)                    from public, anon, authenticated;
revoke all on function public.outbound_claim(integer, integer)                       from public, anon, authenticated;
revoke all on function public.event_checkin(uuid, uuid)                              from public, anon, authenticated;
revoke all on function public.event_walkin_request(uuid, uuid, jsonb, text)          from public, anon, authenticated;
revoke all on function public.event_checkin_by_host(uuid, uuid, uuid)                from public, anon, authenticated;
revoke all on function public.event_reject_walkin(uuid, uuid, uuid)                  from public, anon, authenticated;
revoke all on function public.event_join_community(uuid, uuid)                       from public, anon, authenticated;
revoke all on function public.event_participants(uuid)                               from public, anon, authenticated;
revoke all on function public.event_participant_answers(uuid)                        from public, anon, authenticated;
revoke all on function public.event_after_people(uuid, uuid)                         from public, anon, authenticated;
revoke all on function public.event_meet(uuid, uuid, uuid, boolean)                  from public, anon, authenticated;
grant execute on function public.event_settle(uuid)                                     to service_role;
grant execute on function public.event_settle_due()                                     to service_role;
grant execute on function public.event_create(uuid, uuid, text, timestamptz, timestamptz, text, text, jsonb, smallint, date, timestamptz, text)
                                                                                         to service_role;
grant execute on function public.event_update(uuid, uuid, jsonb)                        to service_role;
grant execute on function public.event_apply(uuid, uuid, jsonb, text, text, jsonb, text) to service_role;
grant execute on function public.event_cancel_registration(uuid, uuid)                  to service_role;
grant execute on function public.event_set_late(uuid, uuid, integer)                    to service_role;
grant execute on function public.outbound_claim(integer, integer)                       to service_role;
grant execute on function public.event_checkin(uuid, uuid)                              to service_role;
grant execute on function public.event_walkin_request(uuid, uuid, jsonb, text)          to service_role;
grant execute on function public.event_checkin_by_host(uuid, uuid, uuid)                to service_role;
grant execute on function public.event_reject_walkin(uuid, uuid, uuid)                  to service_role;
grant execute on function public.event_join_community(uuid, uuid)                       to service_role;
grant execute on function public.event_participants(uuid)                               to service_role;
grant execute on function public.event_participant_answers(uuid)                        to service_role;
grant execute on function public.event_after_people(uuid, uuid)                         to service_role;
grant execute on function public.event_meet(uuid, uuid, uuid, boolean)                  to service_role;

commit;
