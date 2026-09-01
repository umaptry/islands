// Getting in: the intro slides, the real sign-in, and the first profile.
//
// islands had two screens here that did the same thing behind different titles
// ("アカウント作成" and "ログイン"), and both accepted any four digits. There is
// one flow now, because the only real difference between registering and
// logging in is whether the address has been seen before, and the server is the
// only side that knows. The code is a real one-time code from Supabase Auth.

import { config } from '../config.js';
import { EMOJI, avatarCss } from '../avatars.js';
import { AVATAR_IMAGE, prepareImage } from '../image.js';
import { api, data } from '../net.js';
import { session } from '../session.js';
import { state } from '../state.js';
import { navigate, screen } from '../router.js';
import { refreshMyPosts, refreshMyReactions } from './map.js';
import { refreshNotifications } from './notifications.js';
import { $, $$, avatar, clear, el, toast } from '../ui.js';

// ---------------------------------------------------------------- intro

let introIndex = 0;

function paintIntro() {
  const track = $('slideTrack');
  const total = track.children.length;
  track.style.transform = `translateX(${-introIndex * 100}%)`;
  [...$('dots').children].forEach((dot, i) => dot.classList.toggle('on', i === introIndex));
  $('introBack').hidden = introIndex === 0;
  $('introNext').textContent = introIndex === total - 1 ? 'はじめる' : '次へ';
}
export function setupIntro() {
  // Buttons are the only way through. A scroll-snap track let a half swipe
  // settle between two slides with the dots showing one thing and the screen
  // showing another.
  $('introNext').addEventListener('click', () => {
    const total = $('slideTrack').children.length;
    if (introIndex < total - 1) {
      introIndex += 1;
      paintIntro();
    } else {
      navigate('#/auth');
    }
  });
  $('introBack').addEventListener('click', () => {
    if (introIndex > 0) {
      introIndex -= 1;
      paintIntro();
    }
  });
  paintIntro();
  screen('intro', { enter: () => { introIndex = 0; paintIntro(); } });
}

// ---------------------------------------------------------------- sign in

let pendingEmail = '';
const RESEND_COOLDOWN_MS = 60_000;

function showStep(name) {
  $$('.auth-step').forEach((node) => { node.hidden = node.dataset.step !== name; });
}

export function setupAuth() {
  const email = $('authEmail');
  const code = $('authCode');
  const send = $('authSend');
  const verify = $('authVerify');
  let sending = false;
  let resendUntil = 0;
  let resendTimer = null;

  function paintSend() {
    const seconds = Math.max(0, Math.ceil((resendUntil - Date.now()) / 1000));
    if (seconds === 0 && resendTimer) {
      clearInterval(resendTimer);
      resendTimer = null;
    }
    send.disabled = sending || seconds > 0 || !email.value.includes('@');
    send.textContent = sending ? '送信中…' : (
      seconds > 0 ? `再送まで ${seconds}秒` : 'パスコードを送る'
    );
  }

  function startResendCooldown(delay = RESEND_COOLDOWN_MS) {
    // GoTrue has a per-address resend window. Mirroring it in the client
    // prevents accidental double-clicks and back-and-forth navigation from
    // consuming the project-wide mail allowance.
    resendUntil = Math.max(resendUntil, Date.now() + Math.max(delay, RESEND_COOLDOWN_MS));
    if (!resendTimer) resendTimer = setInterval(paintSend, 250);
    paintSend();
  }

  email.addEventListener('input', () => {
    paintSend();
    $('authError').textContent = '';
  });
  code.addEventListener('input', () => {
    // GoTrue's email codes are six digits; local mode's are too. Anything
    // shorter cannot be one, and enabling the button for it only produces a
    // round trip that fails.
    verify.disabled = code.value.trim().length < 4;
    $('authCodeError').textContent = '';
  });
  code.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !verify.disabled) verify.click();
  });
  email.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !send.disabled) send.click();
  });

  send.addEventListener('click', async () => {
    if (sending || Date.now() < resendUntil) return;
    sending = true;
    paintSend();
    try {
      const result = await session.requestCode(email.value);
      pendingEmail = result.email;
      startResendCooldown();
      $('authSentTo').textContent = `${result.email} に届いたパスコードを入力してください。`;
      const devBox = $('authDevCode');
      if (result.devCode) {
        // Local mode has no mail server. Saying so plainly beats a code that
        // appears with no explanation - and this branch cannot run in a deploy,
        // because the route that produces it returns 404 there.
        devBox.hidden = false;
        clear(devBox).append(
          el('span', { className: 'dev-code-label', text: 'ローカルモードのパスコード' }),
          el('strong', { className: 'dev-code-value num', text: result.devCode }),
        );
      } else {
        devBox.hidden = true;
      }
      showStep('code');
      code.value = '';
      verify.disabled = true;
      code.focus();
    } catch (error) {
      $('authError').textContent = error.message;
      if (error.code === 'over_email_send_rate_limit') {
        startResendCooldown(error.retryAfterMs || RESEND_COOLDOWN_MS);
      }
    } finally {
      sending = false;
      paintSend();
    }
  });

  verify.addEventListener('click', async () => {
    verify.disabled = true;
    verify.textContent = '確認中…';
    try {
      await session.verifyCode(pendingEmail, code.value);
      await afterSignIn();
    } catch (error) {
      $('authCodeError').textContent = error.message;
      verify.disabled = false;
    } finally {
      verify.textContent = 'ログイン';
    }
  });

  $('authBack').addEventListener('click', () => {
    showStep('email');
    $('authCodeError').textContent = '';
    paintSend();
  });

  screen('auth', {
    enter: () => {
      showStep('email');
      $('authError').textContent = '';
      paintSend();
      paintOAuth();
    },
  });
}

function paintOAuth() {
  const providers = config().oauth || [];
  const row = $('oauthRow');
  if (!providers.length) {
    // islands showed "Googleで登録" and "Appleのアカウントで登録" buttons that
    // did nothing. A button that cannot work is worse than no button, so these
    // appear only when the provider is actually configured.
    row.hidden = true;
    return;
  }
  row.hidden = false;
  const names = { google: 'Google', apple: 'Apple' };
  $$('.oauth-button', row).forEach((node) => node.remove());
  providers.forEach((provider) => {
    row.append(el('button', {
      className: 'btn btn-outline btn-block oauth-button',
      text: `${names[provider] || provider} で続ける`,
      on: { click: () => session.startOAuth(provider) },
    }));
  });
}

/** Load the account behind the token, then send the person where they belong. */
export async function afterSignIn() {
  let result;
  try {
    result = await api.get('/api/account/me');
  } catch (error) {
    toast(error.message);
    return;
  }
  state.account = result.account;
  if (!state.account || !state.account.display_name) {
    navigate('#/setup');
    return;
  }
  // Signing in mid-session has to pull in what boot() would have: the posts
  // that are mine, what I have already reacted to, and my inbox. Without this
  // the badge stayed empty and every reaction button read as un-pressed until
  // the next reload.
  await Promise.all([
    refreshMyPosts().catch(() => {}),
    refreshMyReactions().catch(() => {}),
    refreshNotifications().catch(() => {}),
  ]);
  navigate('#/map');
}

// ---------------------------------------------------------------- avatar

function paintIconGrid(grid, selected, onPick) {
  clear(grid);
  EMOJI.forEach((emoji, index) => {
    const id = String(index);
    const cell = el('button', {
      className: `icon-cell${id === selected ? ' on' : ''}`,
      attrs: { type: 'button', 'aria-label': `アイコン ${index + 1}` },
      text: emoji,
      style: { background: avatarCss(id) },
      on: {
        click: () => {
          onPick(id);
          $$('.icon-cell', grid).forEach((node, i) => {
            node.classList.toggle('on', String(i) === id);
          });
        },
      },
    });
    grid.append(cell);
  });
}

/**
 * The アイコン field: 30 emoji discs, or a photo.
 *
 * `accounts.avatar_path`, the column grants, the Storage policy and ui.js's
 * rendering branch were all here already; this is the half that was missing,
 * so the second option in 要件 2.2 could not actually be taken.
 *
 * The photo is held as a blob and uploaded by commit(), not when it is picked.
 * That matches the composer, and it means somebody who opens the file dialog
 * and then walks away has not left a file in the bucket.
 *
 * Call once, at wiring time; reset() on every screen entry.
 *
 * @param prefix  'setup' or 'edit' - the id prefix in index.html
 */
export function setupAvatarField(prefix) {
  const preview = $(`${prefix}AvatarPreview`);
  const photoButton = $(`${prefix}AvatarPhoto`);
  const clearButton = $(`${prefix}AvatarClear`);
  const file = $(`${prefix}AvatarFile`);
  const chosen = { icon_id: '0', avatar_path: null };
  let pending = null;        // a prepared blob, not yet uploaded
  let pendingUrl = null;     // its object URL, for the preview

  function releasePending() {
    if (pendingUrl) URL.revokeObjectURL(pendingUrl);
    pending = null;
    pendingUrl = null;
  }

  function paint() {
    const showingPhoto = Boolean(pendingUrl || chosen.avatar_path);
    clear(preview).append(avatar(chosen, 64, pendingUrl));
    clearButton.hidden = !showingPhoto;
    photoButton.textContent = showingPhoto ? '写真を変える' : '写真を選ぶ';
    // A photo wins over the emoji, so nothing in the grid should look chosen.
    $$('.icon-cell', $(`${prefix}Icons`)).forEach((node, index) => {
      node.classList.toggle('on', !showingPhoto && String(index) === chosen.icon_id);
    });
  }

  photoButton.addEventListener('click', () => file.click());

  file.addEventListener('change', async (event) => {
    const picked = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!picked) return;
    try {
      const blob = await prepareImage(picked, AVATAR_IMAGE);
      releasePending();
      pending = blob;
      pendingUrl = URL.createObjectURL(blob);
      paint();
    } catch (error) {
      toast(error.message);
    }
  });

  clearButton.addEventListener('click', () => {
    releasePending();
    chosen.avatar_path = null;
    paint();
  });

  return {
    reset(account = {}) {
      releasePending();
      chosen.icon_id = account.icon_id
        || String(Math.floor(Math.random() * EMOJI.length));
      chosen.avatar_path = account.avatar_path || null;
      paintIconGrid($(`${prefix}Icons`), chosen.icon_id, (id) => {
        chosen.icon_id = id;
        // Choosing a face is also how you take a photo back off.
        releasePending();
        chosen.avatar_path = null;
        paint();
      });
      paint();
    },

    /** Upload anything pending and return what to save. May throw. */
    async commit() {
      if (pending) {
        chosen.avatar_path = await data.uploadImage(pending);
        releasePending();
      }
      // null rather than undefined: the API clears the column on an explicit
      // null, which is what 「絵文字に戻す」 has to mean.
      return { icon_id: chosen.icon_id, avatar_path: chosen.avatar_path };
    },
  };
}

// ---------------------------------------------------------------- setup

export function setupProfileSetup() {
  const name = $('setupName');
  const save = $('setupSave');
  const field = setupAvatarField('setup');
  const sync = () => { save.disabled = !name.value.trim(); };
  name.addEventListener('input', sync);

  save.addEventListener('click', async () => {
    save.disabled = true;
    $('setupError').textContent = '';
    try {
      const result = await api.put('/api/account/me', {
        display_name: name.value.trim(),
        affiliation: $('setupAffiliation').value.trim() || null,
        ...(await field.commit()),
      });
      state.account = result.account;
      // islands walked a new person straight into writing their first post,
      // which is right: an empty map is not something to be dropped into.
      navigate('#/post?first=1');
    } catch (error) {
      $('setupError').textContent = error.message;
      save.disabled = false;
    }
  });

  screen('setup', {
    enter: () => {
      field.reset(state.account || {});
      name.value = (state.account && state.account.display_name) || '';
      $('setupAffiliation').value = (state.account && state.account.affiliation) || '';
      $('setupError').textContent = '';
      sync();
    },
  });
}
