-- 2026-11-07: 投稿と、会の申し込みの答え（やってた／やってる／やりたい）を 60 字から 140 字にする（ユーザーの指示）。
--
--   1. 投稿：トリガー posts_body_limit の 60 を 140 に（列の check は前から 1〜140 なので、そのまま）
--   2. 申し込みの答え：event_answers.body の check を 1〜140 に
--   3. 申し込みの関数 event_apply：答えの長さの確かめを 1〜140 に（M4 の形のまま、その1か所だけ変える）
--
-- 流す順番: **このSQLが先、コードが後**。
--   SQL だけ先に流しても壊れない（古いコードは 60 字までしか送らない）。
--   コードを先に出すと、61 字以上の投稿・答えが DB で止まる（エラーになる）。
--
-- 作り直すだけで、何度流しても壊れない。1本 = 1 transaction。
-- 戻すときは supabase/rollback/20261113000000_body_140_rollback.sql（コードを先に戻してから）。
begin;

set local lock_timeout = '3s';
set local statement_timeout = '60s';

-- 1. 投稿の上限（トリガー）
create or replace function public.posts_body_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if length(new.body) > 140 then
    raise exception 'post body is limited to 140 characters' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- 2. 申し込みの答えの列
alter table public.event_answers drop constraint if exists event_answers_body_check;
alter table public.event_answers
  add constraint event_answers_body_check check (length(body) between 1 and 140);

-- 3. 申し込みの関数（20261111000000_events_b.sql の 5 と同じ。答えの長さだけ 140）
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

  -- 回答（会の質問にある prompt だけ。同じ prompt は1回。本文 1〜140 字。形が違うものは数えない）
  q_count := jsonb_array_length(ev.questions);
  need_ans := case when is_mem then 0 else least(2, q_count) end;
  for a in select x from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) x loop
    pr := a ->> 'prompt';
    bd := btrim(coalesce(a ->> 'body', ''));
    if pr is null or pr = any (seen) or length(bd) not between 1 and 140
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

commit;
