-- 2026-10-26: コミュニティの名前を、そのコミュニティの管理者が変えられるようにする。
--
--   * 関数 rename_community(community uuid, new_name text) returns text
--     管理者（community_members.role = 'admin'）だけが呼べる。前後の空白（全角を含む）を取り、
--     1〜40字でなければ止める（communities.name の check と create_community と同じ決まり）。
--     変えたあとの名前を返す。
--
-- 足すだけの変更で、何度流しても壊れない（create or replace function と、権限の付け直しだけ）。
-- 今の本番のコード（main）はこの関数を呼ばないので、先に流してもそのまま動く。
-- **出す順番**: ① この SQL → ② コード（コードより先に流す）。
begin;

create or replace function public.rename_community(community uuid, new_name text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  cleaned text;
begin
  if auth.uid() is null then
    raise exception 'ログインしてください。';
  end if;
  -- 管理者かどうかは、この関数の中で community_members を見て決める（呼ぶ人の言い分は信じない）。
  if community is null or not exists (
       select 1 from public.community_members m
        where m.community_id = rename_community.community
          and m.account_id = auth.uid()
          and m.role = 'admin') then
    raise exception 'このコミュニティの名前は、管理者だけが変えられます。';
  end if;
  -- 前後の空白を取る。半角のほか、日本語の入力で入りやすい全角の空白（U+3000）も。
  cleaned := btrim(coalesce(new_name, ''), E' \t\r\n\u3000');
  if char_length(cleaned) < 1 or char_length(cleaned) > 40 then
    raise exception 'コミュニティの名前は1〜40文字で入力してください。';
  end if;
  update public.communities set name = cleaned where id = rename_community.community;
  return cleaned;
end $$;

revoke all on function public.rename_community(uuid, text) from public, anon;
grant execute on function public.rename_community(uuid, text) to authenticated;

commit;
