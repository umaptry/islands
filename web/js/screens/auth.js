// Getting in: the welcome page, the real sign-in, the first profile and the guidance.
//
// The order follows the design mock (モック②): the way in, name / 所属 / mail,
// the passcode, then the icon photo, the two ようこそ pages, the 案内 page and
// the first post. The passcode is a real one (a mail from Supabase Auth, or the
// number shown on the screen in local mode); the mock's "any four digits" is
// not here. The icon is a photo or nothing: the 30 emoji are gone, and a person
// who chooses no photo gets a silhouette.
//
// islands had two screens here that did the same thing behind different titles
// ("アカウント作成" and "ログイン"), and both accepted any four digits. There is
// one flow now, because the only real difference between registering and
// logging in is whether the address has been seen before, and the server is the
// only side that knows. The code is a real one-time code from Supabase Auth.

import { config } from '../config.js';
import { PHOTO_ICON, hasEmoji } from '../avatars.js';
import { AVATAR_IMAGE, prepareImage } from '../image.js';
import { api, data } from '../net.js';
import { session } from '../session.js';
import { state } from '../state.js';
import { onboardingStep, setOnboardingStep } from '../onboarding.js';
import { navigate, screen } from '../router.js';
import { refreshMyPosts, refreshMyReactions } from './map.js';
import { refreshNotifications } from './notifications.js';
import { browserStorage, refreshTalk } from '../talk.js';
import { mapLinkFor, takePendingPost } from '../return-post.js';
import { $, $$, avatar, clear, el, toast } from '../ui.js';

// ---------------------------------------------------------------- welcome

export function setupWelcome() {
  $('welcomeRegister').addEventListener('click', () => navigate('#/auth?intent=register'));
  $('welcomeLogin').addEventListener('click', () => navigate('#/auth?intent=login'));
  $('welcomeBrowse').addEventListener('click', () => navigate('#/map'));
  screen('welcome', { enter() {
    const box = clear($('welcomeOAuth'));
    const providers = config().oauth || [];
    providers.forEach((provider) => box.append(el('button', {
      className: `btn btn-block ${OAUTH[provider]?.className || ''}`,
      text: OAUTH[provider]?.register || `${provider}で登録`,
      on: { click: () => session.startOAuth(provider) },
    })));
    // The 「または」 line only means something when there is a choice above it,
    // and then the button under it says what it signs you up with.
    $('welcomeDivider').hidden = providers.length === 0;
    $('welcomeRegister').textContent = providers.length ? 'メールアドレスで登録' : 'アカウント作成';
  } });
}

// ---------------------------------------------------------------- sign in

// The sign-in services the server may switch on (/api/config `oauth`).
const OAUTH = {
  google: { name: 'Google', register: 'Googleで登録', className: 'oauth-google' },
  line: { name: 'LINE', register: 'LINEで登録', className: 'oauth-line' },
  apple: { name: 'Apple', register: 'Appleのアカウントで登録', className: 'oauth-apple' },
};

let pendingEmail = '';
let registerIntent = false;
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
  let resendFor = '';      // the address the wait belongs to
  let resendTimer = null;
  const normalized = (value) => String(value || '').trim().toLowerCase();

  // The wait is per address: another address is not held back by it.
  function waitLeft() {
    if (!resendFor || normalized(email.value) !== resendFor) return 0;
    return Math.max(0, Math.ceil((resendUntil - Date.now()) / 1000));
  }

  function paintSend() {
    const seconds = waitLeft();
    if (seconds === 0 && resendTimer) {
      clearInterval(resendTimer);
      resendTimer = null;
    } else if (seconds > 0 && !resendTimer) {
      resendTimer = setInterval(paintSend, 250);
    }
    send.disabled = sending || seconds > 0 || !email.value.includes('@') || (registerIntent && !$('registerName').value.trim());
    send.textContent = sending ? '送信中…' : (
      seconds > 0 ? `再送まで ${seconds}秒` : '次へ'
    );
  }

  function startResendCooldown(address, delay = RESEND_COOLDOWN_MS) {
    // GoTrue has a per-address resend window. Mirroring it in the client
    // prevents accidental double-clicks and back-and-forth navigation from
    // consuming the project-wide mail allowance.
    const until = Date.now() + Math.max(delay, RESEND_COOLDOWN_MS);
    resendUntil = resendFor === address ? Math.max(resendUntil, until) : until;
    resendFor = address;
    paintSend();
  }

  email.addEventListener('input', () => {
    paintSend();
    $('authError').textContent = '';
  });
  $('registerName').addEventListener('input', paintSend);
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
    if (sending || waitLeft() > 0) return;
    sending = true;
    paintSend();
    try {
      const result = await session.requestCode(email.value);
      pendingEmail = result.email;
      startResendCooldown(normalized(email.value));
      $('authSentTo').textContent = `送り先：${result.email}`;
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
        startResendCooldown(normalized(email.value), error.retryAfterMs || RESEND_COOLDOWN_MS);
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
      verify.textContent = '次へ';
    }
  });

  $('authBack').addEventListener('click', () => {
    showStep('email');
    $('authCodeError').textContent = '';
    paintSend();
  });

  // Signing out leaves nothing of the last person on the form: the address,
  // the code and the resend wait all go (otherwise the next person is held
  // back by 「再送まで N秒」 for an address that is not theirs).
  window.addEventListener('islands:signout', () => {
    email.value = '';
    code.value = '';
    $('registerName').value = '';
    $('authError').textContent = '';
    $('authCodeError').textContent = '';
    verify.disabled = true;
    resendUntil = 0;
    resendFor = '';
    pendingEmail = '';
    showStep('email');
    paintSend();
  });

  screen('auth', {
    enter: (_params, query) => {
      registerIntent = query?.get('intent') === 'register';
      $('registerFields').hidden = !registerIntent;
      $('auth').classList.toggle('register', registerIntent);
      $('authLede').textContent = registerIntent ? '下記の情報を入力してください。' : 'メールアドレスを入力してください。';
      const title = registerIntent ? 'アカウント作成' : 'ログイン';
      document.querySelector('#auth [data-step="email"] h2').textContent = title;
      document.querySelector('#auth [data-step="code"] h2').textContent = title;
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
  $$('.oauth-button', row).forEach((node) => node.remove());
  providers.forEach((provider) => {
    row.append(el('button', {
      className: `btn btn-outline btn-block oauth-button ${OAUTH[provider]?.className || ''}`,
      text: `${OAUTH[provider]?.name || provider} で続ける`,
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
    if (registerIntent && $('registerName').value.trim()) {
      try {
        // icon_id PHOTO_ICON marks the account as "photo only" from the start,
        // so a person who skips the photo gets the silhouette and not the
        // default emoji the column would otherwise hand out.
        state.account = (await api.put('/api/account/me', {
          display_name: $('registerName').value.trim(),
          affiliation: $('registerAffiliation').value.trim() || null,
          icon_id: PHOTO_ICON,
        })).account;
        setOnboardingStep('photo');
        navigate('#/setup');
      } catch (error) {
        toast(error.message);
        await navigate('#/setup');
        $('setupName').value = $('registerName').value.trim();
        $('setupAffiliation').value = $('registerAffiliation').value.trim();
        $('setupName').dispatchEvent(new Event('input'));
      }
      return;
    }
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
    refreshTalk(),
  ]);
  // Came here from a link to one post (#/map?post=...): straight back to it. A new
  // person is not here yet - theirs opens after the first post (compose.js).
  const waiting = onboardingStep() ? null : takePendingPost(browserStorage());
  navigate(waiting ? mapLinkFor(waiting) : '#/map');
}

// ---------------------------------------------------------------- avatar

/**
 * The アイコン field: a photo, or nothing.
 *
 * `accounts.avatar_path`, the column grants, the Storage policy and ui.js's
 * rendering branch were all here already. The 30 emoji discs that used to sit
 * under the photo button are gone (モック②: the icon is a photo); a person who
 * still has an emoji keeps seeing it until they set a photo, and 「写真を外す」
 * gives it back to them.
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
  const size = prefix === 'setup' ? 112 : 72;
  const chosen = { icon_id: PHOTO_ICON, avatar_path: null };
  let pending = null;        // a prepared blob, not yet uploaded
  let pendingUrl = null;     // its object URL, for the preview

  function releasePending() {
    if (pendingUrl) URL.revokeObjectURL(pendingUrl);
    pending = null;
    pendingUrl = null;
  }

  function paint() {
    const showingPhoto = Boolean(pendingUrl || chosen.avatar_path);
    clear(preview).append(avatar(chosen, size, pendingUrl));
    clearButton.hidden = !showingPhoto;
    photoButton.textContent = showingPhoto ? '写真を変える' : '写真を選ぶ';
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
      // An old emoji icon stays as it is; everybody else is "photo only".
      chosen.icon_id = hasEmoji(account.icon_id) ? String(account.icon_id) : PHOTO_ICON;
      chosen.avatar_path = account.avatar_path || null;
      paint();
    },

    /** Upload anything pending and return what to save. May throw. */
    async commit() {
      if (pending) {
        chosen.avatar_path = await data.uploadImage(pending);
        releasePending();
      }
      // null rather than undefined: the API clears the column on an explicit
      // null, which is what 「写真を外す」 has to mean.
      return { icon_id: chosen.icon_id, avatar_path: chosen.avatar_path };
    },
  };
}

// ---------------------------------------------------------------- setup

/**
 * The icon-photo step. Registration has already saved the name by the time it
 * gets here, so the name boxes stay hidden; a sign-in that arrives with no name
 * at all (a provider account, an address signed in from the login page) gets
 * them on this same screen.
 */
export function setupProfileSetup() {
  const name = $('setupName');
  const save = $('setupSave');
  const field = setupAvatarField('setup');
  let needsName = false;
  const sync = () => { save.disabled = needsName && !name.value.trim(); };
  name.addEventListener('input', sync);

  save.addEventListener('click', async () => {
    save.disabled = true;
    $('setupError').textContent = '';
    try {
      const result = await api.put('/api/account/me', {
        ...(needsName ? {
          display_name: name.value.trim(),
          affiliation: $('setupAffiliation').value.trim() || null,
        } : {}),
        ...(await field.commit()),
      });
      state.account = result.account;
      setOnboardingStep('0');
      // islands walked a new person straight into writing their first post,
      // which is right: an empty map is not something to be dropped into.
      navigate('#/guidance');
    } catch (error) {
      $('setupError').textContent = error.message;
      save.disabled = false;
    }
  });

  screen('setup', {
    enter: () => {
      needsName = !(state.account && state.account.display_name);
      $('setupNameFields').hidden = !needsName;
      $('setupTitle').textContent = needsName ? 'プロフィール' : 'アイコンの写真を選びましょう';
      field.reset(needsName ? {} : state.account);
      name.value = (state.account && state.account.display_name) || '';
      $('setupAffiliation').value = (state.account && state.account.affiliation) || '';
      $('setupError').textContent = '';
      sync();
    },
  });
}

// ---------------------------------------------------------------- guidance

// The picture slides (the 「使い方を見る」 intro that was, and what the lines
// between people mean), shown once to a new account between the profile and the
// first post. Buttons are the only
// way through: a scroll-snap track let a half swipe settle between two slides
// with the dots showing one thing and the screen showing another.
// 見直し: マイページの「islands の使い方を見る」から開いたとき。登録直後の
// 流れ(onboarding の段階)には一切さわらず、終わったらマイページへ戻る。
let reviewFromMe = false;
export function markGuidanceReview() { reviewFromMe = true; }

export function setupGuidance() {
  let index = 0;
  let review = false;
  const track = () => $('guidanceTrack');
  const dots = () => [...$('guidanceDots').children];

  function paint() {
    const slides = [...track().children];
    track().style.transform = `translateX(${-index * 100}%)`;
    // The slides beside the one in view are only slid out of sight.
    slides.forEach((slide, i) => { slide.inert = i !== index; });
    dots().forEach((dot, i) => dot.classList.toggle('on', i === index));
    $('guidanceBack').hidden = index === 0;
    const last = index === slides.length - 1;
    $('guidanceNext').textContent = last ? (review ? '閉じる' : 'ひとこと書いてみる') : '次へ';
    if (!review) setOnboardingStep(String(index));
  }

  // The last slide and 「スキップ」 end the same way: on to the first post.
  const finish = () => {
    if (review) {
      // マイページから来たなら履歴を一つ戻る(戻る操作と同じ)。直接開いたなら置き換える。
      if (reviewFromMe) { reviewFromMe = false; history.back(); }
      else navigate('#/me', { replace: true });
      return;
    }
    setOnboardingStep('post');
    navigate('#/post?first=1');
  };
  $('guidanceSkip').addEventListener('click', finish);
  $('guidanceNext').addEventListener('click', () => {
    const total = track().children.length;
    if (index < total - 1) {
      index += 1;
      paint();
    } else {
      finish();
    }
  });
  $('guidanceBack').addEventListener('click', () => {
    if (index > 0) {
      index -= 1;
      paint();
    }
  });

  screen('guidance', {
    enter: (_params, query) => {
      // 登録の途中(onboarding の段階が残っている)ときは、いつもの流れを優先する。
      review = Boolean(query && query.get('review') === '1') && !onboardingStep();
      $('guidance').classList.toggle('is-review', review);
      $('guidanceSkip').textContent = review ? '閉じる' : 'スキップ';
      if (review) {
        index = 0;
      } else {
        const saved = Number(onboardingStep());
        index = Number.isInteger(saved) && saved >= 0 && saved < track().children.length ? saved : 0;
      }
      paint();
    },
    leave: () => { reviewFromMe = false; },
  });
}
