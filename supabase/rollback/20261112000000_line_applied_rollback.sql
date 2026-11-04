-- 戻し用: 20261112000000_line_applied.sql（LINE の「受け付けました」）を取り消す。
--
-- **supabase/migrations の外に置いている**（CLI は migrations の中のファイルを全部流してしまうため）。
-- 本番では Supabase の SQL エディタで、必要なときだけ流す。**コードを先に戻してから**流す
-- （戻さなくても申し込みは通るが、新しいコードは呼べなかったことを毎回記録する）。
--
-- 戻すもの:
--   * 関数 event_queue_applied を消す
--   * 「受け付けました」の予約（kind = 'applied'）を、送ったものも含めて消す（check を元に戻すため）
--   * outbound_messages.kind の check を M3 の6つに戻す
--
-- 何度流しても壊れない。
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';

drop function if exists public.event_queue_applied(uuid, uuid);

delete from public.outbound_messages where kind = 'applied';

alter table public.outbound_messages drop constraint if exists outbound_messages_kind_check;
alter table public.outbound_messages add constraint outbound_messages_kind_check
  check (kind in ('week_before', 'day_of', 'after', 'declined', 'event_cancelled', 'event_changed'));

commit;
