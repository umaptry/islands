-- 2026-10-28: islands_state.intro（島の一言紹介）。
-- Run with: supabase test db (CI does). Everybody here is made up.
begin;
select no_plan();

select has_column('public', 'islands_state', 'intro', 'islands keep a one-line intro');
select col_is_null('public', 'islands_state', 'intro', 'and it may be empty');
select lives_ok(
  $$insert into public.islands_state(name, name_source, intro)
     values ('キャンプ', 'ai', '週末は山へ。焚き火を囲むのが好きな人たち')$$,
  'an AI-named island is saved with its intro');
select lives_ok($$insert into public.islands_state(name) values ('古い島')$$,
                'an island saved by old code (no intro) still works');
select is((select intro from public.islands_state where name = '古い島'), null,
          'its intro is empty');
select lives_ok($$update public.islands_state set intro = null where name = 'キャンプ'$$,
                'an intro can be cleared');
select throws_ok(
  $$insert into public.islands_state(name, intro) values ('長い', repeat('あ', 61))$$,
  '23514', null, 'an intro is 60 characters at most');
select lives_ok(
  $$insert into public.islands_state(name, intro) values ('ちょうど', repeat('あ', 60))$$,
  'and 60 is fine');

select * from finish();
rollback;
