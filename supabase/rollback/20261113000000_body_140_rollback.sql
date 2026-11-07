-- 戻し用: 20261113000000_body_140.sql（投稿と申し込みの答えを 140 字に）を取り消して 60 字に戻す。
--
-- **supabase/migrations の外に置いている**（CLI は migrations の中のファイルを全部流してしまうため）。
-- 本番では Supabase の SQL エディタで、必要なときだけ流す。**コードを先に戻してから**流す。
--
-- すでに書かれた 61〜140 字の投稿・答えは消さない（トリガーは本文を書くときだけ、答えの check は not valid）。
-- 何度流しても壊れない。
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';

create or replace function public.posts_body_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if length(new.body) > 60 then
    raise exception 'post body is limited to 60 characters' using errcode = '23514';
  end if;
  return new;
end;
$$;

alter table public.event_answers drop constraint if exists event_answers_body_check;
alter table public.event_answers
  add constraint event_answers_body_check check (length(body) between 1 and 60) not valid;

-- 20261111000000_events_b.sql の 5 のまま
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


commit;
