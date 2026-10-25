-- 2026-10-28: 島の一言紹介（islands_state.intro）。
--
--   * AI（Gemini）が島の名前を付けるとき、同じ呼び出しで「その島の住人がどんな人たちか」を
--     30字以内の一文で書く。それを島ごとに残す（名前と同じ島の持ち物）。
--   * null = まだ無い（古い島・AI を呼べなかった島・手で名前を付けた島）。画面は島の話題語から
--     作った予備の文を出す。
--   * 手で名前を付けた島（name_source = 'manual'）にコードが紹介文を書くことはない。
--   * 「新しい住人」の通知は type = 'island' の行（payload.kind = 'resident'）で書くので、
--     notifications の型の check は変えない。
--
-- 何度流しても壊れない。古いコードでも壊れない（古いコードはこの列を読まない・書かない）。
-- コードより先に流すこと。流す前にコードが出ても、コードは列が無いのを見分けて島の保存・読み込みを続ける。
begin;

alter table public.islands_state add column if not exists intro text;

alter table public.islands_state drop constraint if exists islands_state_intro_check;
alter table public.islands_state add constraint islands_state_intro_check
  check (intro is null or char_length(intro) <= 60);

commit;
