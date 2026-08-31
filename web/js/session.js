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
      throw new Error(message || 'サインインできませんでした。');
    }
    return payload;
  });
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
    await gotrue('otp', { email: address, create_user: true });
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
      `${url}/auth/v1/authorize?provider=${encodeURIComponent(provider)}` +
      `&redirect_to=${encodeURIComponent(redirect)}`;
  },

  /** Pick up an OAuth redirect. Returns true when one was consumed. */
  adoptRedirect() {
    if (!window.location.hash.includes('access_token=')) return false;
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get('access_token');
    if (!token) return false;
    store({
      access_token: token,
      refresh_token: params.get('refresh_token'),
      expires_in: Number(params.get('expires_in') || 3600),
      // The id is inside the token. Reading it here avoids a round trip just to
      // learn who we are, and the signature is checked by the server on every
      // request anyway - nothing is trusted because of this decode.
      user: { id: decodeSub(token), email: null },
    });
    history.replaceState(null, '', window.location.pathname);
    return true;
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

function decodeSub(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(part.padEnd(part.length + ((4 - part.length % 4) % 4), '='))).sub;
  } catch {
    return null;
  }
}
