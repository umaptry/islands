-- 2026-10-12: モック反映（サーバー担当分）
--
--   * 島の名前を AI（Gemini）で付ける。islands_state に「名前の出どころ」と
--     「その名前を付けたときの投稿の顔ぶれ」を持たせる。顔ぶれがほぼ変わらない間は
--     前の名前を使い回し、AI を呼び直さない。
--       name_source  null / 'terms'（上位語）/ 'genre'（活動ジャンル。AI なしで、島の言葉に
--                    意味の近いジャンルを決まった一覧から選んだ名前）/ 'ai' /
--                    'manual'（人が SQL で固定した名前。
--                    'manual' の島はコードが名前を変えず、AI も呼ばない）
--       name_basis   AI が名前を付けた（または付けようとして失敗した）ときの投稿ID。
--                    null = まだ試していない
--       name_tried_at  AI に最後に聞いた時刻。成功も失敗も入る。24時間は同じ島を聞き直さない
--   * 通知「新しいつながり」(connection) を作らない。notify_new_connection() は
--     呼び出し元のトリガ（反応・コメント）をそのままに、何もしない関数へ置き換える。
--     すでにある connection / similar の通知は消さない（一覧にはそのまま残る）。
--     「似た人」(similar) はサーバーのコードが作っていたので DB 側の変更は無い。
--
-- 固定の例（名前を人が決めたいとき。島の id は select id, name from islands_state で調べる）:
--   update public.islands_state set name = '手芸', name_source = 'manual' where id = '…';
-- 固定をやめるとき:
--   update public.islands_state set name_source = 'terms' where id = '…';
--
-- 何度流しても壊れない。古いコードでも壊れない（新しい列は古いコードが読まない・
-- 書かない。notify_new_connection の署名は同じ）。コードより先に流すこと。
begin;

alter table public.islands_state
  add column if not exists name_source text,
  add column if not exists name_basis  uuid[],
  add column if not exists name_tried_at timestamptz;

alter table public.islands_state drop constraint if exists islands_state_name_source_check;
alter table public.islands_state add constraint islands_state_name_source_check
  check (name_source is null or name_source in ('terms', 'genre', 'ai', 'manual'));

create or replace function public.notify_new_connection(a uuid, b uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  -- 廃止（2026-10-12）。署名と権限は変えないので、呼ぶ側のトリガはそのまま動く。
  return;
end $$;
revoke all on function public.notify_new_connection(uuid, uuid) from public, anon, authenticated;

commit;
