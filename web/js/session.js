// Signing in.
//
// islands had a registration screen where any four digits got you in, and a
// "user" that was a hard-coded object in a Zustand store. This is the real
// thing: Supabase Auth issues a one-time code by email, the browser exchanges
// it for a JWT, and Postgres checks that same JWT on every row it is asked for.
//
// The token lives in localStorage. Safari in private mode - and any browser
// with site data blocked - THROWS from localStorage rather than returning null,
// so every access is wrapped: the failure mode is "you have to sign in again
// next time", never "the app does not start".

import { config, isLocal } from './config.js';

const STORAGE_KEY = 'kasanari-session';
// Refresh a minute early. A token that expires between the check and the
// request arriving is a 401 the user reads as being logged out at random.
const REFRESH_MARGIN = 60_000;
// LINE is not one of Supabase's built-in providers: it is added in the dashboard
// as a custom OIDC provider with this identifier (docs/operations_runbook.md).
const SUPABASE_PROVIDERS = { line: 'custom:line' };

function read() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    return null;
  }
}

function write(value) {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

let current = null;
let refreshing = null;
const listeners = new Set();

function announce() {
  listeners.forEach((listener) => listener(current));
}

function gotrue(path, body, { token } = {}) {
  const { url, anon_key: key } = config().supabase;
  const headers = { apikey: key, 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${url}/auth/v1/${path}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  }).then(async (response) => {
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload && (payload.msg || payload.error_description || payload.message);
      const error = new Error(message || 'サインインできませんでした。');
      // Keep GoTrue's machine-readable code and Retry-After hint. The screen
      // can then distinguish a temporary sending limit from a bad address or
      // a network error without relying on English error text alone.
      error.code = payload && (payload.code || payload.error_code);
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        error.retryAfterMs = retryAfter * 1000;
      }
      throw error;
    }
    return payload;
  });
}

function isEmailRateLimited(error) {
  return error && (
    error.code === 'over_email_send_rate_limit' ||
    /email rate limit exceeded/i.test(String(error.message || ''))
  );
}

function store(payload) {
  // GoTrue reports expires_in (seconds from now); local mode has no expiry at
  // all. Normalising to an absolute millisecond stamp here means the refresh
  // check below is the same line in both modes.
  const expiresAt = payload.expires_in
    ? Date.now() + payload.expires_in * 1000
    : Number.MAX_SAFE_INTEGER;
  current = {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || null,
    expires_at: expiresAt,
    user_id: (payload.user && payload.user.id) || null,
    email: (payload.user && payload.user.email) || null,
    provider: (payload.user && payload.user.provider) || null,   // 'google', 'custom:line'; null for the passcode
  };
  write(current);
  announce();
  return current;
}

async function refresh() {
  if (!current || !current.refresh_token || isLocal()) return current;
  if (refreshing) return refreshing;
  refreshing = gotrue('token?grant_type=refresh_token', {
    refresh_token: current.refresh_token,
  })
    .then((payload) => store(payload))
    .catch(() => {
      // A refresh token the server has forgotten is not recoverable. Clearing
      // is better than looping: the sign-in screen is one tap.
      session.signOut();
      return null;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export const session = {
  restore() {
    current = read();
    return current;
  },
  signedIn: () => Boolean(current && current.access_token),
  userId: () => (current ? current.user_id : null),
  email: () => (current ? current.email : null),
  /** How this session signed in: 'google', 'custom:line', or null (the passcode). */
  provider: () => (current ? current.provider || null : null),

  async validateUser() {
    if (!current || isLocal()) return;
    const { url, anon_key } = config().supabase;
    const token = await this.accessToken();
    if (!token) return;
    const response = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anon_key, authorization: `Bearer ${token}` },
    });
    if (response.status === 401 || response.status === 403) this.signOut();
    else if (!response.ok) throw new Error('認証状態を確認できませんでした。');
  },

  async accessToken() {
    if (!current) return null;
    if (current.expires_at - REFRESH_MARGIN < Date.now()) await refresh();
    return current ? current.access_token : null;
  },

  /** Ask for a one-time code. Returns the code itself in local mode only. */
  async requestCode(email) {
    const address = String(email || '').trim().toLowerCase();
    if (!address.includes('@')) throw new Error('メールアドレスを入力してください。');
    if (isLocal()) {
      const response = await fetch('/api/local/auth/otp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: address }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || 'コードを送れませんでした。');
      return { email: address, devCode: payload.code };
    }
    // create_user: true is what makes this one flow serve both "register" and
    // "log in". islands had two screens that did the same thing; the only real
    // difference is whether the address has been seen before, and the server
    // is the only side that knows.
    try {
      await gotrue('otp', {
        email: address,
        create_user: true,
        email_redirect_to: `${window.location.origin}/`,
      });
    } catch (error) {
      if (!isEmailRateLimited(error)) throw error;
      const friendly = new Error(
        'メール送信の上限に達しました。連続送信を避け、しばらく待ってからもう一度お試しください。',
      );
      friendly.code = 'over_email_send_rate_limit';
      friendly.retryAfterMs = error.retryAfterMs;
      throw friendly;
    }
    return { email: address, devCode: null };
  },

  async verifyCode(email, code) {
    const address = String(email || '').trim().toLowerCase();
    const token = String(code || '').trim();
    if (isLocal()) {
      const response = await fetch('/api/local/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: address, code: token }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || 'パスコードが違います。');
      return store(payload);
    }
    return store(await gotrue('verify', { email: address, token, type: 'email' }));
  },

  /** OAuth is a full-page redirect; the token comes back in the URL fragment. */
  startOAuth(provider) {
    const { url } = config().supabase;
    const redirect = `${window.location.origin}/`;
    window.location.href =
      `${url}/auth/v1/authorize?provider=${encodeURIComponent(SUPABASE_PROVIDERS[provider] || provider)}` +
      `&redirect_to=${encodeURIComponent(redirect)}`;
  },

  /** Pick up an OAuth redirect: 'adopted' when it signed somebody in, 'failed'
   * when the provider or Supabase sent back an error (a cancel included), null
   * when this page load is not a redirect. Either way the address is cleaned,
   * or the router would read `#error=...` as a route. */
  adoptRedirect() {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const query = new URLSearchParams(window.location.search);
    if (fragment.get('error') || query.get('error')) {
      history.replaceState(null, '', window.location.pathname);
      return 'failed';
    }
    const token = fragment.get('access_token');
    if (!token) return null;
    // Who and how are inside the token. Reading them here avoids a round trip,
    // and the signature is checked by the server on every request anyway -
    // nothing is trusted because of this decode; the email is only shown.
    const claims = tokenClaims(token) || {};
    store({
      access_token: token,
      refresh_token: fragment.get('refresh_token'),
      expires_in: Number(fragment.get('expires_in') || 3600),
      user: {
        id: claims.sub || null,
        email: claims.email || null,
        provider: (claims.app_metadata && claims.app_metadata.provider) || null,
      },
    });
    history.replaceState(null, '', window.location.pathname);
    return 'adopted';
  },

  signOut() {
    current = null;
    write(null);
    announce();
  },

  onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

function tokenClaims(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(part.padEnd(part.length + ((4 - part.length % 4) % 4), '=')), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function decodeSub(token) {
  const claims = tokenClaims(token);
  return claims ? claims.sub : null;
}
