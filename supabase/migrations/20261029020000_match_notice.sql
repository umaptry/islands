-- 2026-10-29: 「つながりの通知」（notifications.type = 'match'）。
--
-- 新しい投稿 P が、だれかの前の投稿 Q とつながるとき、Q の書き手に 'match' の通知を1行ずつ書く
-- （core/matching.py が決める。payload は {kind, other_post, reason}）。設定の分類は「反応」（reaction）。
--
-- コードより先に流す。流すまでは match の通知は保存されず（type の制約が断る）、警告ログだけが残る。
-- 投稿そのものは無事（通知は応答のあと別のスレッドで作り、失敗しても投稿には響かない）。
--
-- 足すだけ・何度流しても壊れない・古いコードでも壊れない:
--   * notifications_type_check: 既存の type をすべて残して 'match' を足す。
--   * notification_feed(): 20261027010000_members_only_lockdown.sql の定義をそのまま写し、
--     分類（cat）の reaction に 'match' を足しただけ。同じ引数・同じ戻り値。まとめるのは今までどおり
--     like / help / join だけなので、match は1行ずつ出る。
-- Python のミラー: core/config.py の NOTIFICATION_CATEGORY_OF、core/notifications.py の group_feed。
begin;

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('like', 'help', 'join', 'comment', 'reply', 'connection', 'similar', 'island',
                  'quiet_post', 'talk_wish', 'talk_match', 'dm', 'match'));

create or replace function public.notification_feed(limit_n integer default 50)
returns table (id uuid, type text, category text, post_id uuid, comment_id uuid,
               island_id uuid, event_id uuid, payload jsonb, actor_id uuid,
               others integer, created_at timestamptz, unread boolean, ids uuid[])
language sql stable security definer set search_path = public as $$
  with mine as (
    select n.*,
           case when n.type in ('like', 'help', 'join', 'talk_wish', 'talk_match', 'match') then 'reaction'
                when n.type in ('comment', 'reply', 'dm') then 'reply'
                when n.type = 'quiet_post' then 'similar'
                else n.type end as cat,
           n.type in ('like', 'help', 'join') as chainable
      from public.notifications n
     where n.recipient_id = auth.uid()
       and (n.post_id is null or public.is_member_of_post_any(n.post_id))
       and (n.community_id is null or n.community_id in (select public.my_community_ids()))
       and (n.type not in ('island', 'quiet_post', 'similar') or n.community_id is not null)
  ), chained as (
    select m.*,
           case when m.chainable
                 and lag(m.created_at) over w is not null
                 and m.created_at - lag(m.created_at) over w <= interval '10 minutes'
                then 0 else 1 end as starts
      from mine m
    window w as (partition by m.cat, m.post_id, m.chainable order by m.created_at)
  ), grouped as (
    select c.*,
           case when c.chainable
                then sum(c.starts) over (partition by c.cat, c.post_id, c.chainable order by c.created_at)
                else null end as chain,
           case when c.chainable then null else c.id end as solo
      from chained c
  )
  select (array_agg(g.id order by g.created_at desc))[1],
         (array_agg(g.type order by g.created_at desc))[1],
         g.cat,
         (array_agg(g.post_id order by g.created_at desc))[1],
         (array_agg(g.comment_id order by g.created_at desc))[1],
         (array_agg(g.island_id order by g.created_at desc))[1],
         (array_agg(g.event_id order by g.created_at desc))[1],
         (array_agg(g.payload order by g.created_at desc))[1],
         (array_agg(g.actor_id order by g.created_at desc))[1],
         greatest(count(distinct g.actor_id) - 1, 0)::int,
         max(g.created_at),
         bool_or(g.read_at is null),
         array_agg(g.id order by g.created_at desc)
    from grouped g
   group by g.cat, g.post_id, g.chainable, g.chain, g.solo
   order by max(g.created_at) desc
   limit greatest(1, least(limit_n, 200))
$$;

commit;
