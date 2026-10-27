-- 2026-10-28: 投稿のお題に「困ってること」（posts.prompt = 'help'）を足す。
--
-- お題は CHECK 制約で決め打ちしているので、新しいお題を入れられるように作り直す。
-- 足すだけの変更で、何度流しても壊れない。古いコードは 'help' を送らないので、そのまま動く。
-- コードより先でも後でもよい。流すまでは、新しいコードは「困ってること」で書いた投稿を
-- お題なしで保存する（本文・タグ「助けてほしい」はそのまま。core/store.py の _send_post_fields）。
-- 流したあとに書いた投稿から、お題 'help' が記録される。
begin;

alter table public.posts drop constraint if exists posts_prompt_check;
alter table public.posts add constraint posts_prompt_check
  check (prompt is null or prompt in ('weekly', 'past', 'now', 'future', 'help'));

commit;
