-- 戻し用: 20261031010000_dm_read.sql（DM の既読）を取り消す。
--
-- **supabase/migrations の外に置いている**（CLI は migrations の中のファイルを全部流してしまうため）。
-- 本番では Supabase の SQL エディタで、必要なときだけ流す。
--
-- 消すもの: 関数 mark_dm_read・dm_partner_read_at と表 dm_reads（読んだ時刻の記録もすべて消える）。
-- DM のメッセージ・部屋・ブロックには触らない。
-- コードを先に戻す必要は無い: 関数が無いとき、画面は既読の機能を黙って止める。
--
-- 何度流しても壊れない。
begin;
set local lock_timeout = '3s';

drop function if exists public.mark_dm_read(uuid);
drop function if exists public.dm_partner_read_at(uuid);
drop table if exists public.dm_reads;

commit;
