"""Shared fixtures.

Every test runs against the local-mode app: no Supabase project, MemoryStore
behind the API, and the /api/local/* shim standing in for PostgREST. That is a
deliberate choice rather than a convenience - it means the suite needs no
services, and it means the shim (which is what local development actually uses)
is exercised by every run rather than rotting quietly.
"""

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# The app refuses to boot with a Supabase URL it cannot verify tokens against,
# and MemoryStore is what makes the suite hermetic.
for name in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY", "SUPABASE_ANON_KEY"):
    os.environ.pop(name, None)
os.environ["KOTOBA_DISABLE_RATE_LIMIT"] = "1"

pytest.importorskip("fastapi")

# Texts used across several modules. Two people saying the same thing in
# different words, one saying something else entirely.
CAMPING_A = "週末はソロキャンプに出かけて、焚き火を眺めながら静かに過ごすのが好きです。"
CAMPING_B = "山で野営をするのが趣味で、薪を割って火をおこす時間がいちばん落ち着きます。"
CAMPING_C = "週末はキャンプで焚き火を眺めるのが好きです。道具を少しずつ揃えています。"
BOOKKEEPING = "簿記二級の勉強をしています。毎晩、過去問を解いてから寝るのが日課になりました。"
SOLDERING = "電子工作にはまっていて、基板を設計しています。半田付けをしながら深夜ラジオを聴くのが習慣です。"


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient

    import app as application

    with TestClient(application.app) as test_client:
        yield test_client


@pytest.fixture
def fresh_client():
    """A client whose store starts empty. For tests that count things."""
    from fastapi.testclient import TestClient

    import app as application
    from core.store import MemoryStore

    with TestClient(application.app) as test_client:
        application.state["store"] = MemoryStore()
        application.invalidate_islands()
        yield test_client


@pytest.fixture(scope="module")
def loaded(client):
    """The app state, guaranteed populated by the lifespan."""
    import app as application

    return application.state


class Person:
    """A signed-in account, with the headers to prove it."""

    def __init__(self, client, email, name):
        from core import auth

        self.client = client
        self.email = email
        code = client.post("/api/local/auth/otp", json={"email": email}).json()["code"]
        token = client.post(
            "/api/local/auth/verify", json={"email": email, "code": code}
        ).json()
        assert token.get("access_token"), token
        self.id = token["user"]["id"]
        self.headers = {"Authorization": f"Bearer {token['access_token']}"}
        assert auth  # imported for the side effect of proving it is importable
        response = client.put(
            "/api/account/me", json={"display_name": name, "icon_id": "1"},
            headers=self.headers,
        )
        assert response.status_code == 200, response.text
        self.account = response.json()["account"]

    def post(self, body, **fields):
        payload = {"body": body, "tags": [], "motivation": 50}
        payload.update(fields)
        response = self.client.post("/api/posts", json=payload, headers=self.headers)
        assert response.status_code == 200, response.text
        return response.json()

    def react(self, post_id, kind):
        return self.client.post(
            "/api/local/reactions", json={"post_id": post_id, "kind": kind},
            headers=self.headers,
        )

    def unreact(self, post_id, kind):
        return self.client.request(
            "DELETE", f"/api/local/reactions?post_id={post_id}&kind={kind}",
            headers=self.headers,
        )

    def comment(self, post_id, body):
        return self.client.post(
            "/api/local/comments", json={"post_id": post_id, "body": body},
            headers=self.headers,
        )

    def inbox(self):
        return self.client.get(
            "/api/local/notifications", headers=self.headers
        ).json()["notifications"]

    def unread(self):
        return [row for row in self.inbox() if not row["read_at"]]


@pytest.fixture
def people(fresh_client):
    """A factory for signed-in people on a clean store."""
    made = {}

    def make(email, name):
        if email not in made:
            made[email] = Person(fresh_client, email, name)
        return made[email]

    return make
