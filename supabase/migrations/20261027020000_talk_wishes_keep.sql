-- 2026-10-27: 「もっと話してみたい」を押した記録を、取り消すか両思いになるまで残す。
--
--   * 何を変えたか: press_talk と my_talk_state を create or replace し直しただけ（引数・戻り値・
--     security definer・search_path は同じ）。変えたのは2点。
--       - press_talk: 「14日より古い talk_wishes を消す」掃除をやめた。
--       - my_talk_state: pressed に「14日以内」の条件をつけていたのをやめた。
--   * なぜ: 押した記録が14日で消えると、AさんがBさんを押した15日後にBさんがAさんを押しても、
--     Aさんの行がもう無いので両思いにならず、DM が開かなかった。押した記録は本人が取り消す
--     （withdraw_talk）か、両思いになる（2人の行を消す。今のまま）まで残す。
--   * 変えないもの: 同じ人から同じ人への片思い通知（talk_wish）は14日に1回までというやがらせ対策。
--     talk_wish_notices とその14日の掃除・判定は今のまま。両思いで2人の行を消す動きも今のまま。
--     20261027010000_members_only_lockdown.sql は press_talk / my_talk_state を変えていないので、
--     土台は 20261026000000_talk_and_dm.sql の定義（talk_peers には触らない）。
--   * 古いコードでも動く: 関数の形が同じで、古いコードは何も変えずに呼べる。何度流しても同じ結果。
--     すでに14日で消えた行は戻らない（押し直してもらう）。
--   * 戻し方: 本番SQL_3回目_メンバーだけ\戻すとき_押した記録を14日に戻す.sql を流す
--     （元の press_talk / my_talk_state の定義。コードは戻さなくてよい）。
begin;

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

-- 自分が押した相手(pressed)と、DM が開いている相手(matched)。相手から押されているかは返さない。
create or replace function public.my_talk_state()
returns table (target uuid, state text, room_id uuid)
language sql stable security definer set search_path = public as $$
  select w.to_id, 'pressed'::text, null::uuid
    from public.talk_wishes w
   where w.from_id = auth.uid()
  union all
  select case when r.user_a = auth.uid() then r.user_b else r.user_a end, 'matched'::text, r.id
    from public.dm_rooms r
   where auth.uid() = r.user_a or auth.uid() = r.user_b
$$;

revoke all on function public.press_talk(uuid)       from public, anon;
revoke all on function public.my_talk_state()        from public, anon;
grant execute on function public.press_talk(uuid)    to authenticated;
grant execute on function public.my_talk_state()     to authenticated;

commit;
