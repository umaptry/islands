-- 2026-10-28: 「もっと話してみたい」を押せる相手を、同じコミュニティのメンバー全員に広げる。
--
--   * 何を変えたか: 押せる条件を「同じ『参加者募集中』の投稿に参加した人どうし」から
--     「少なくとも1つ同じコミュニティに2人とも入っている」へ。今までの条件（同じ会）は、会の
--     コミュニティに2人とも入っていることが前提だったので、新しい条件にそのまま含まれる。
--       - talk_same_community(a, b): 新しい。2人に共通のコミュニティがあるか。外からは呼べない。
--       - talk_peers(): 自分が入っているコミュニティのメンバー全員（自分とブロック相手を除く）。
--       - press_talk(): 断る条件を talk_same_community に差し替え。それ以外（14日に1回の通知、
--         未読の talk_wish があれば足さない、両思いで2人の行を消す、ロックの順）は 20261027020000 のまま。
--     talk_shared_event は変えない。部屋・押した記録の event_post_id には、共通の会があればその最新の会、
--     なければ null が入る（dm_rooms.event_post_id・talk_wishes.event_post_id は null を許す列）。
--   * 古いコードでも動く: 関数の名前・引数・戻り値・権限・security definer・search_path は今のまま。
--     何度流しても同じ結果。
--   * 流す順: コードより先に流してよい（古いコードは同じ RPC を呼ぶだけ）。
--   * 戻し方: 20261027010000_members_only_lockdown.sql の talk_peers と
--     20261027020000_talk_wishes_keep.sql の press_talk を流し直す。
begin;

create or replace function public.talk_same_community(a uuid, b uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select a is not null and b is not null and a <> b
     and exists (select 1
                   from public.community_members ma
                   join public.community_members mb on mb.community_id = ma.community_id
                  where ma.account_id = a and mb.account_id = b)
$$;

create or replace function public.talk_peers()
returns table (account_id uuid)
language sql stable security definer set search_path = public as $$
  select distinct mb.account_id
    from public.community_members ma
    join public.community_members mb on mb.community_id = ma.community_id
   where auth.uid() is not null
     and ma.account_id = auth.uid()
     and mb.account_id <> auth.uid()
     and not public.talk_blocked(auth.uid(), mb.account_id)
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
  -- 同じコミュニティのメンバーでない・ブロック関係は、同じ文言（ブロックされたことを教えない）。
  -- 共通の会があればその最新の会、なければ null（会が無くても押せる）。
  if not public.talk_same_community(me, target) or public.talk_blocked(me, target) then
    raise exception 'この相手には押せません。';
  end if;
  shared_event := public.talk_shared_event(me, target);

  -- 同じ受け取る人に、別々の2人が同時に押しても、「未読の通知があれば足さない」の判定を
  -- 見逃さない（2行出ない）よう、受け取る人ごとに順番に処理する。ロックを取る順は
  -- いつも「受け取る人 → 2人1組」。この順を変えるとデッドロックになりうる。
  perform pg_advisory_xact_lock(hashtextextended('talk-target:' || target::text, 0));
  -- 同じ2人が同時に押しても、お互いの行を見逃さないよう、組ごとに順番に処理する。
  lo := least(me, target);
  hi := greatest(me, target);
  perform pg_advisory_xact_lock(hashtextextended(lo::text || ':' || hi::text, 0));

  -- ついでの掃除。2週間より古い「通知を書いた記録」は消える（押した記録 talk_wishes は消さない）。
  delete from public.talk_wish_notices where notified_at < now() - interval '14 days';

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
    -- 名前なし・会なし（actor_id, post_id などはすべて NULL）。足さないのは次の2つのとき:
    --   1. 受け取る人に未読の talk_wish がすでにある（読む前は何人押しても「誰か」は1行）
    --   2. 同じ人から同じ人へ、14日以内に通知を書いている（押す→取り消す→押すで送り続けられない）
    -- 読まれたあとに別の人（または14日後の同じ人）に押されれば、すぐ新しい通知になる。
    if not exists (select 1 from public.notifications n
                    where n.recipient_id = target and n.type = 'talk_wish' and n.read_at is null)
       and not exists (select 1 from public.talk_wish_notices k
                        where k.from_id = me and k.to_id = target
                          and k.notified_at > now() - interval '14 days') then
      insert into public.notifications (recipient_id, actor_id, type)
      values (target, null::uuid, 'talk_wish');
      insert into public.talk_wish_notices (from_id, to_id) values (me, target)
      on conflict (from_id, to_id) do update set notified_at = now();
    end if;
    insert into public.talk_stats (day, pressed) values (today, 1)
    on conflict (day) do update set pressed = public.talk_stats.pressed + 1;
  end if;
  return jsonb_build_object('matched', false, 'room_id', null::uuid);
end $$;

revoke all on function public.talk_same_community(uuid, uuid) from public, anon, authenticated;
revoke all on function public.talk_peers()        from public, anon;
revoke all on function public.press_talk(uuid)    from public, anon;
grant execute on function public.talk_peers()     to authenticated;
grant execute on function public.press_talk(uuid) to authenticated;

commit;
