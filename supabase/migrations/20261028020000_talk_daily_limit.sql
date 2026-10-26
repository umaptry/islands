-- 2026-10-28: 「もっと話してみたい」を押せるのは、押す人ごとに1日20人まで。
--
--   * なぜ: 同じコミュニティの全員に押せるようにしたので（20261028010000）、1人が全員に押して
--     「誰か」の通知を送りつけられる。押す人ごとに日本時間の1日20人までにする。
--   * 数えるのは「新しく押した」とき: 片思いの行が新しくできたとき、と、押し返して両思い（部屋ができた）とき。
--     すでに押している相手をもう一度押す・すでに部屋がある相手を押す、は数えず、断りもしない（返り値も今のまま）。
--     取り消しても数は戻らない（押す→取り消す→押す、で送り続けられないように）。
--   * 21人目は断る: 「今日はここまでです。…」（P0001。画面はこの文をそのまま出す）。
--     20 は core/config.py の TALK_DAILY_PRESS_LIMIT と同じ数。変えるときは両方を直す。
--   * 新しい表 talk_daily_presses (account_id, day, presses): 日ごとの押した人数。talk_stats と同じく
--     RLS オン・anon / authenticated からは読めも書けもしない。press_talk（security definer）だけが触る。
--     2日より前の行は press_talk がついでに消す。
--   * press_talk: 20261028010000 からの変更は上限だけ。ロックの順（受け取る人 → 2人1組）も、
--     数える表の更新は最後（ほかのロックを待たない）なので、デッドロックにならない。
--     数える更新は「presses < 20 のときだけ +1」の1文なので、同じ人が別々の相手へ同時に押しても20を超えない。
--     断るときは例外で全部が巻き戻る（途中の掃除も含め、何も残らない）。
--   * 古いコードでも動く: 関数の名前・引数・戻り値・権限・security definer・search_path は今のまま。
--     何度流しても同じ結果。
--   * 流す順: コードより先に流してよい（古いコードは同じ RPC を呼ぶだけ。21人目だけ断られる）。
--   * 戻し方: 20261028010000_talk_community_peers.sql の press_talk を流し直す（表は残ってよい）。
begin;

create table if not exists public.talk_daily_presses (
  account_id uuid    not null references auth.users(id) on delete cascade,
  day        date    not null,
  presses    integer not null default 0,
  primary key (account_id, day)
);
alter table public.talk_daily_presses enable row level security;
revoke all on table public.talk_daily_presses from public, anon, authenticated;
drop policy if exists talk_daily_presses_none on public.talk_daily_presses;
create policy talk_daily_presses_none on public.talk_daily_presses for all using (false) with check (false);
grant all on public.talk_daily_presses to service_role;

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
  counted      integer;
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
  -- 2日より前の「1日に押した人数」も消える。
  delete from public.talk_daily_presses where day < today - 1;

  -- すでに部屋がある（両思い済み）。何も増やさない・数えない。
  select r.id into found_room from public.dm_rooms r where r.user_a = lo and r.user_b = hi;
  if found_room is not null then
    return jsonb_build_object('matched', true, 'room_id', found_room);
  end if;

  -- 相手がすでに自分を押していた: 両思い。新しく押したので1人と数える（上限は 20 = TALK_DAILY_PRESS_LIMIT）。
  if exists (select 1 from public.talk_wishes w where w.from_id = target and w.to_id = me) then
    insert into public.talk_daily_presses as d (account_id, day, presses) values (me, today, 1)
    on conflict (account_id, day) do update set presses = d.presses + 1 where d.presses < 20;
    get diagnostics counted = row_count;
    if counted = 0 then
      raise exception '今日はここまでです。「もっと話してみたい」を押せるのは1日20人までで、明日（0時すぎ）からまた押せます。';
    end if;
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

  -- 片思い。すでに押していたら何もしない（数えない・通知も件数も増やさない）。
  -- 新しく押すときだけ1人と数える（上限は 20 = TALK_DAILY_PRESS_LIMIT）。同じ組はロック済みなので、
  -- ここで「まだ押していない」と見たものは、この先の insert で必ず新しい行になる。
  if not exists (select 1 from public.talk_wishes w where w.from_id = me and w.to_id = target) then
    insert into public.talk_daily_presses as d (account_id, day, presses) values (me, today, 1)
    on conflict (account_id, day) do update set presses = d.presses + 1 where d.presses < 20;
    get diagnostics counted = row_count;
    if counted = 0 then
      raise exception '今日はここまでです。「もっと話してみたい」を押せるのは1日20人までで、明日（0時すぎ）からまた押せます。';
    end if;
  end if;
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

revoke all on function public.press_talk(uuid) from public, anon;
grant execute on function public.press_talk(uuid) to authenticated;

commit;
