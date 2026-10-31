-- 2026-10-31: DM の吹き出しに絵文字で反応できるようにする（長押し → ハート・いいね・笑い・びっくり・悲しい・ありがとう）。
--
--   * dm_reactions   どのメッセージに、誰が、どの反応を付けたか。1つのメッセージに1人1つ（主キーが
--                    (message_id, account_id)）。kind は絵文字の文字ではなく「種類のキー」で保存する
--                    （heart / thumbs / laugh / wow / sad / pray）。画面がキーを絵文字に直す。
--                    読めるのは部屋の2人だけ。書く権限も policy もクライアントには無い（関数だけが書く）。
--                    room_id は「部屋の2人だけが読める」policy と、部屋ごとの取り出しのために持つ。
--   * 関数 react_dm(msg_id, new_kind)（security definer。anon には execute を与えない。ログインの JWT で呼ぶ）。
--     部屋の2人のどちらかで、どちら向きにもブロックが無いときだけ通る。
--     同じ反応がすでにあれば外し（{"kind": null}）、違う反応なら付け替え、無ければ付ける（{"kind": "heart"} など）。
--     room_id は関数がメッセージから取る（クライアントには渡させない）。
--
-- 通知は出さない（notifications に書かない・プッシュしない）。DM の一覧のプレビューや未読も変わらない。
-- 相手には、部屋を開いたとき（開いている間は5秒ごとの確認）に見える。
--
-- 足すだけの変更で、何度流しても壊れない。古いコードは新しい表も関数も使わないので、そのまま動く。
-- コードより前でも後でもよい。流すまでは、新しいコードが dm_reactions を読めない（404）ことを黙って受け止め、
-- 長押しで「コピー」だけを出す。流したあとは、次に部屋を開いたときから反応が使える。
-- 戻すときは supabase/rollback/20261031000000_dm_reactions_rollback.sql を流す（コードだけ戻しても無害）。
--
-- 保守モード（check_map_maintenance）のトリガーは、新しい表には付けない。dm_messages などと同じ理由:
-- 保守は投稿から計算した値を作り直す間の書き込みを止めるためのもので、DM の反応はそれと無関係。
begin;

-- ===========================================================================
-- 1. Table
-- ===========================================================================
create table if not exists public.dm_reactions (
  message_id uuid not null references public.dm_messages (id) on delete cascade,
  room_id    uuid not null references public.dm_rooms (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  kind       text not null check (kind in ('heart', 'thumbs', 'laugh', 'wow', 'sad', 'pray')),
  created_at timestamptz not null default now(),
  primary key (message_id, account_id)
);
create index if not exists dm_reactions_room_idx on public.dm_reactions (room_id);

-- ===========================================================================
-- 2. Privileges and row level security
-- ===========================================================================
alter table public.dm_reactions enable row level security;
revoke all on public.dm_reactions from anon, authenticated;

-- 読むのは部屋の2人だけ。書くのは react_dm だけ（insert/update/delete の権限も policy も無い）。
drop policy if exists dm_reactions_select on public.dm_reactions;
create policy dm_reactions_select on public.dm_reactions for select to authenticated
  using (exists (select 1 from public.dm_rooms r
                  where r.id = dm_reactions.room_id
                    and (auth.uid() = r.user_a or auth.uid() = r.user_b)));
grant select on public.dm_reactions to authenticated;
grant all on public.dm_reactions to service_role;

-- ===========================================================================
-- 3. What the browser calls (JWT of the signed-in person)
-- ===========================================================================
-- 反応を付ける・付け替える・外す。返り値は {"kind": "heart"}（いま付いている反応）か {"kind": null}（外れた）。
-- 部屋の外の人・知らないメッセージ・ブロック関係は、同じ文言（ブロックされたことを教えない。
-- dm_messages_guard と同じ 42501）。
create or replace function public.react_dm(msg_id uuid, new_kind text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me   uuid := auth.uid();
  rid  uuid;
  ua   uuid;
  ub   uuid;
  cur  text;
begin
  if me is null then
    raise exception 'ログインしてください。';
  end if;
  select m.room_id, r.user_a, r.user_b into rid, ua, ub
    from public.dm_messages m
    join public.dm_rooms r on r.id = m.room_id
   where m.id = msg_id;
  if not found or me not in (ua, ub) or public.talk_blocked(ua, ub) then
    raise exception 'このメッセージには反応できません。' using errcode = '42501';
  end if;
  if new_kind is null or new_kind not in ('heart', 'thumbs', 'laugh', 'wow', 'sad', 'pray') then
    raise exception 'その反応は使えません。';
  end if;

  select x.kind into cur from public.dm_reactions x
   where x.message_id = msg_id and x.account_id = me
   for update;
  if found and cur = new_kind then
    delete from public.dm_reactions where message_id = msg_id and account_id = me;
    return jsonb_build_object('kind', null);
  end if;
  -- 付け替えも、同時に2回押されたときの付けるも、1つの文で済ませる。
  insert into public.dm_reactions (message_id, room_id, account_id, kind)
  values (msg_id, rid, me, new_kind)
  on conflict (message_id, account_id) do update set kind = excluded.kind, created_at = now();
  return jsonb_build_object('kind', new_kind);
end $$;

revoke all on function public.react_dm(uuid, text) from public, anon;
grant execute on function public.react_dm(uuid, text) to authenticated;

commit;
