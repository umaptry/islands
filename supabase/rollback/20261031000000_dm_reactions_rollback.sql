-- 戻し用: 20261031000000_dm_reactions.sql（DM の絵文字の反応）を取り消す。
--
-- **supabase/migrations の外に置いている**（CLI は migrations の中のファイルを全部流してしまうため）。
-- 本番では Supabase の SQL エディタで、必要なときだけ流す。
--
-- 消すもの: 関数 react_dm と表 dm_reactions（付いた反応もすべて消える）。DM のメッセージ・部屋・ブロックには触らない。
-- コードを先に戻す必要は無い: dm_reactions が無いとき、画面は反応の機能を黙って止めて、長押しで「コピー」だけを出す。
--
-- 何度流しても壊れない。
begin;
set local lock_timeout = '3s';

drop function if exists public.react_dm(uuid, text);
drop table if exists public.dm_reactions;

commit;
