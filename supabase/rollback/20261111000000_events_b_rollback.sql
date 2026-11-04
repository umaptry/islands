-- 戻し用: 20261111000000_events_b.sql（会の開催条件と第2回b の M4）を取り消す。
--
-- **supabase/migrations の外に置いている**（CLI は migrations の中のファイルを全部流してしまうため）。
-- 本番では Supabase の SQL エディタで、必要なときだけ流す。**コードを先に戻してから**流す
-- （新しいコードが消えた関数・列を使うと、会の画面・受付が動かなくなる）。
--
-- 戻すもの:
--   * M4 で足した関数をすべて消す（判定・受付・飛び入り・参加する・参加者リスト・会のあと・会えてよかった・中だけの3つ）
--   * event_create を M3 の8引数の形に戻す（12引数の形は消す）
--   * event_update / event_apply / event_cancel_registration / event_set_late / event_queue_reminders / outbound_claim を
--     M3（20261106000000_events.sql）の定義に戻す（本文は M3 のファイルからそのまま写した）
--   * events の列を消す: min_participants・decide_on・cancel_deadline・join_policy・decision・decided_at
--     （**最小開催人数・判定日・キャンセル期限・入り方・開催の判定の記録は消える**）
-- 戻さないもの: 受付で入ったメンバー（community_members の joined_via = 'event'）、受付で写した投稿、
--   受付済み（attended）・受付待ち（waiting）の申し込みの行、会えてよかった（event_meetings）の行。
--   どれも M3 の表の形のままなので、残っていても M3 のコードは動く。
--
-- 確かめる（消える前の設定）:
--   select post_id, title, min_participants, decide_on, cancel_deadline, join_policy, decision from public.events
--    where min_participants is not null or cancel_deadline is not null or join_policy <> 'auto' or decision is not null;
--
-- 何度流しても壊れない。
begin;
set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- 1. M4 で足した関数
drop function if exists public.event_settle(uuid);
drop function if exists public.event_settle_due();
drop function if exists public.event_checkin(uuid, uuid);
drop function if exists public.event_walkin_request(uuid, uuid, jsonb, text);
drop function if exists public.event_checkin_by_host(uuid, uuid, uuid);
drop function if exists public.event_reject_walkin(uuid, uuid, uuid);
drop function if exists public.event_join_community(uuid, uuid);
drop function if exists public.event_participants(uuid);
drop function if exists public.event_participant_answers(uuid);
drop function if exists public.event_after_people(uuid, uuid);
drop function if exists public.event_meet(uuid, uuid, uuid, boolean);
drop function if exists public.event_after_attend(uuid, uuid);
drop function if exists public.event_admit(uuid, uuid);
drop function if exists public.event_live_count(uuid);

-- 2. 作り直した関数を M3 の形に戻す（以下、20261106000000_events.sql からそのまま）
drop function if exists public.event_create(uuid, uuid, text, timestamptz, timestamptz, text, text, jsonb, smallint, date, timestamptz, text);

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

-- 送る予定を取り出す（二重取りなし）。時刻が来ていて、未送信で、貸し出し中でなく（claimed_at が無いか、
-- p_lease_seconds より前）、5回未満の試行で、予定から24時間以内で、友だちの人の行だけ。
-- for update skip locked で取り、claimed_at を今にして attempts を1増やす。
create or replace function public.outbound_claim(p_limit integer default 50, p_lease_seconds integer default 300)
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

-- 3. events の列
drop index if exists public.events_undecided_idx;
alter table public.events drop constraint if exists events_min_decide_pair;
alter table public.events drop column if exists min_participants;
alter table public.events drop column if exists decide_on;
alter table public.events drop column if exists cancel_deadline;
alter table public.events drop column if exists join_policy;
alter table public.events drop column if exists decision;
alter table public.events drop column if exists decided_at;

-- 4. 権限（M3 と同じ。必ず先に revoke）
revoke all on function public.event_create(uuid, uuid, text, timestamptz, timestamptz, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.event_update(uuid, uuid, jsonb)                          from public, anon, authenticated;
revoke all on function public.event_apply(uuid, uuid, jsonb, text, text, jsonb, text)  from public, anon, authenticated;
revoke all on function public.event_cancel_registration(uuid, uuid)                    from public, anon, authenticated;
revoke all on function public.event_set_late(uuid, uuid, integer)                      from public, anon, authenticated;
revoke all on function public.outbound_claim(integer, integer)                         from public, anon, authenticated;
grant execute on function public.event_create(uuid, uuid, text, timestamptz, timestamptz, text, text, jsonb) to service_role;
grant execute on function public.event_update(uuid, uuid, jsonb)                          to service_role;
grant execute on function public.event_apply(uuid, uuid, jsonb, text, text, jsonb, text)  to service_role;
grant execute on function public.event_cancel_registration(uuid, uuid)                    to service_role;
grant execute on function public.event_set_late(uuid, uuid, integer)                      to service_role;
grant execute on function public.outbound_claim(integer, integer)                         to service_role;

commit;
