"""Python（SupabaseStore の会まわり）と DB（20261106000000_events.sql）の約束を、SQL の文面と見比べる。

2026-11-01 第2回a の組み合わせ：
  * Python が呼ぶ RPC の名前・引数名（p_○○）が、DB の関数の定義と同じか
  * DB にあるサーバー用の関数のうち、Python が呼ばないものが無いか（要らない関数を残さない）
  * 表を直接読む所（PostgREST の select）の列・表が、DB の表にあるか
Supabase に繋がずに、ストアの下回り（_send / _get）を差し替えて、送る中身だけを見る。
"""

import re
from pathlib import Path

import pytest

from core.store import SupabaseStore

SQL = (Path(__file__).resolve().parent.parent / "supabase" / "migrations" / "20261106000000_events.sql").read_text(
    encoding="utf-8")
NOW = "2026-11-10T00:00:00+00:00"
UID = "00000000-0000-4000-8000-000000000001"


def sql_functions():
    """{関数名: {引数名: 既定値があるか}}（このファイルで作る関数。トリガー関数・中だけの関数も入る）。"""
    found = {}
    for match in re.finditer(r"create (?:or replace )?function public\.(\w+)\((.*?)\)\s*returns", SQL, re.S):
        args = {}
        for part in match.group(2).split(","):
            if part.strip():
                args[part.strip().split()[0]] = " default " in part
        found[match.group(1)] = args
    return found


def sql_columns(table):
    block = re.search(rf"create table if not exists public\.{table} \((.*?)\n\);", SQL, re.S).group(1)
    names = set()
    for line in block.splitlines():
        word = line.strip().split(" ")[0].strip(",")
        if word and word not in ("primary", "check", "foreign", "unique", "--") and not word.startswith("--"):
            names.add(word)
    return names


class Recorder(SupabaseStore):
    supports_events_b = False                # このファイルは第2回a の SQL と見比べる（第2回b は test_events_b.py）

    def __init__(self):                      # 繋がない
        self.rpcs, self.reads = [], []

    def _send(self, method, path, label=None, json=None, allow_statuses=(), **kwargs):
        name = path.removeprefix("rpc/")
        self.rpcs.append((name, json))
        body = [] if name in ("event_answer_vectors", "outbound_claim") else {
            "ok": True, "remaining": 1, "registrations": 0, "account_ids": [], "status": "applied"}

        class Response:
            status_code = 200
            content = b"x"
            text = "x"

            def json(self):
                return body
        return Response()

    def _get(self, table, params=None, label=None, **kwargs):
        self.reads.append((table, dict(params or {})))
        return []


CALLS = [
    ("event_create", dict(post=UID, actor=UID, title="t", starts=NOW, ends=NOW, place="", visibility="public",
                          questions=[])),
    ("event_update", dict(post=UID, actor=UID, fields={"title": "x"})),
    ("event_apply", dict(event=UID, account=UID, profile={}, channel="line", referral=None, answers=[], consent="v")),
    ("event_cancel_registration", dict(event=UID, account=UID)),
    ("event_set_late", dict(event=UID, account=UID, minutes=10)),
    ("event_decline", dict(event=UID, host=UID, account=UID)),
    ("event_probe_hit", dict(event=UID, device="d", ip="i")),
    ("event_cleanup", dict()),
    ("account_by_line_sub", dict(sub="U1")),
    ("line_link_save", dict(account=None, line_user_id="U1", is_friend=True)),
    ("line_link_attach", dict(account=UID, line_user_id="U1")),
    ("line_link_unfollow", dict(line_user_id="U1")),
    ("line_webhook_seen", dict(webhook_event_id="w")),
    ("outbound_claim", dict()),
    ("outbound_done", dict(id=UID, ok=True)),
    ("event_answer_vectors", dict(event_id=UID)),
]


@pytest.fixture(scope="module")
def called():
    store = Recorder()
    for name, kwargs in CALLS:
        getattr(store, name)(**kwargs)
    return store.rpcs


def test_every_rpc_python_calls_exists_with_the_same_argument_names(called):
    functions = sql_functions()
    assert len(called) == len(CALLS)
    for name, payload in called:
        assert name in functions, f"DB に {name} が無い"
        assert set(payload) <= set(functions[name]), (name, set(payload) - set(functions[name]))
        # 既定値の無い引数は、Python が必ず送る（既定値があるのは p_now・p_limit などだけ）
        required = {arg for arg, has_default in functions[name].items() if not has_default}
        assert required <= set(payload), (name, required - set(payload))


def test_server_only_functions_not_called_by_python_are_listed_on_purpose():
    """DB のサーバー用の関数（service_role に渡すもの）のうち、Python が RPC で呼ばないものは、ここに理由つきで並べる。"""
    granted = set(re.findall(r"grant execute on function public\.(\w+)\([^;]*to service_role;", SQL))
    called_names = {name for name, _ in CALLS}
    not_called = granted - called_names
    # 理由：event_cleanup などは呼ぶ。ここに残るのは無いはず（my_event_registrations は Python が表を読むので DB から消した）
    assert not_called == set(), not_called


def test_the_rpc_that_python_reads_through_tables_is_gone_from_the_db():
    assert "my_event_registrations" not in sql_functions()


def test_probe_arguments_are_passed_through_without_a_second_hash(called):
    payload = dict(called)["event_probe_hit"]
    assert payload == {"p_event": UID, "p_device": "d", "p_ip": "i"}
    assert "md5(" not in SQL.split("function public.event_probe_hit(")[1].split("end $$")[0]


def test_line_link_save_without_an_account_sends_null(called):
    assert dict(called)["line_link_save"] == {"p_account": None, "p_line_user_id": "U1", "p_is_friend": True}


def test_tables_python_reads_have_those_columns():
    store = Recorder()
    store.event_by_code("c")
    store.event_registration(UID, UID)
    store.my_event_registrations(UID)
    store.line_link_of(UID)
    store.event_roster(UID)
    columns = {t: sql_columns(t) for t in ("events", "event_registrations", "line_links")}
    for table, params in store.reads:
        if table not in columns:
            continue
        for key in params:
            if key in ("select", "limit", "order"):
                continue
            assert key in columns[table], (table, key)
    embedded = next(p["select"] for t, p in store.reads if t == "event_registrations" and "events(" in p.get("select", ""))
    wanted = embedded.split("events(")[1].rstrip(")").split(",")
    assert set(wanted) <= columns["events"]
    # 名簿・LINE の読みで使う列（select の中身）も
    for table, params in store.reads:
        if table in ("line_links", "event_registrations") and params.get("select") not in (None, "*"):
            names = {n for n in re.split(r"[,()]", params["select"]) if n and n not in ("events", "*")}
            assert (names - set(wanted)) <= columns[table], (table, names)
