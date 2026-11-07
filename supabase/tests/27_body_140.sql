-- 2026-11-07: 投稿と、会の申し込みの答えは 140 字まで（20261113000000_body_140.sql）。
begin;
select no_plan();

select ok((select bool_and(prosrc like '%between 1 and 140%' and prosrc not like '%between 1 and 60%')
             from pg_proc where proname = 'event_apply' and pronamespace = 'public'::regnamespace),
          'event_apply takes answers of up to 140 characters');
select ok(pg_get_constraintdef((select oid from pg_constraint where conname = 'event_answers_body_check'))
            like '%140%',
          'event_answers.body is checked at 140');
select ok((select prosrc like '%> 140%' from pg_proc where proname = 'posts_body_limit' and pronamespace = 'public'::regnamespace),
          'the post trigger holds 140');

select * from finish();
rollback;
