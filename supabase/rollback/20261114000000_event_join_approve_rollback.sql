-- 20261114000000_event_join_approve.sql を戻す（コードを先に戻してから流す）。
--   approve の会は ask（希望したらそのまま加入）に戻す。会から希望した人の承認待ちは、ふつうの承認待ちとして残る。
begin;

set local lock_timeout = '3s';
set local statement_timeout = '60s';

drop function if exists public.event_request_join(uuid, uuid);
drop function if exists public.event_join_request_state(uuid, uuid);

update public.events set join_policy = 'ask' where join_policy = 'approve';
alter table public.events drop constraint if exists events_join_policy_check;
alter table public.events
  add constraint events_join_policy_check check (join_policy in ('auto', 'ask', 'none'));

-- 会を作る・変える・承認する（前の形。20261111000000_events_b.sql・20261101000000_join_approval.sql と同じ）
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

alter table public.community_join_requests drop column if exists event_post_id;

commit;
