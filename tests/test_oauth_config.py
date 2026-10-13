"""Sign-in buttons appear only for the services switched on in the environment."""


def test_no_sign_in_service_unless_switched_on(client, monkeypatch):
    for name in ("KOTOBA_OAUTH_GOOGLE", "KOTOBA_OAUTH_LINE", "KOTOBA_OAUTH_APPLE"):
        monkeypatch.delenv(name, raising=False)
    assert client.get("/api/config").json()["oauth"] == []


def test_google_and_line_when_switched_on(client, monkeypatch):
    monkeypatch.setenv("KOTOBA_OAUTH_GOOGLE", "1")
    monkeypatch.setenv("KOTOBA_OAUTH_LINE", "1")
    monkeypatch.delenv("KOTOBA_OAUTH_APPLE", raising=False)
    assert client.get("/api/config").json()["oauth"] == ["google", "line"]
