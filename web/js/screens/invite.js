// The way in by invitation: #/invite/<code>[?post=<id>], and what happens to an
// invite after somebody signs in.
//
// The code (and the post that came with it) is kept in storage before any sign-in
// begins, because signing in with Google leaves the page and comes back to a bare
// address. Once a person is signed in, settleSession() claims it, whichever way
// they arrived: the e-mail flow (auth.js afterSignIn) or a Google return (app.js).
//
// A NEW account has to claim before its profile is saved: with invite_only the
// database refuses to create the account row otherwise.

import { config } from '../config.js';
import { data } from '../net.js';
import { session } from '../session.js';
import { state } from '../state.js';
import { navigate, screen } from '../router.js';
import { $, avatar, clear, el, toast } from '../ui.js';
import { browserStorage } from '../talk.js';
import { WAITING_HOLD_MS, mapLinkFor, saveInviteJoin, savePendingPost, validPostId } from '../return-post.js';
import { isRecruiting } from '../map/reads.js';
import { recruitState } from '../recruit-rules.js';
import { communitiesActive, dropCommunities, joinedCommunity, refreshCommunities, refreshJoinStatus } from '../communities.js';
import {
  ADMIN_SEES_BOX, CONSENT_AFTER_PRESS, NEW_ACCOUNT_NOTE, claimedIn, RETRY_LATER_NOTE, clearPendingInvite, inviteActions, inviteJoinNote, inviteView, readClaim,
  readInviteCheck, readPendingInvite, registrationBlocked, savePendingInvite, transientFailure,
  validInviteCode,
} from '../community-rules.js';

const OAUTH_NAMES = {
  google: { label: 'Googleで登録', className: 'oauth-google' },
  line: { label: 'LINEで登録', className: 'oauth-line' },
  apple: { label: 'Appleのアカウントで登録', className: 'oauth-apple' },
};

/** Use a code now (signed in). Throws with a sentence for a person when it fails. */
export async function claimInvite({ code, post = null }, { holdPost = true } = {}) {
  const claimed = readClaim(await data.claimInvite(code));
  if (!claimed) throw new Error('この招待は使えませんでした。');
  // An application that waits for an admin does not make me a member yet: nothing is joined, and the post and
  // the 会 of the QR are kept for longer, until the admin has answered.
  const waits = !claimedIn(claimed);
  if (!waits) joinedCommunity(claimed);
  const hold = waits ? WAITING_HOLD_MS : 0;
  // The post that came with the invite opens through the same road as a linked post.
  if (post && holdPost) savePendingPost(browserStorage(), post, Date.now(), hold);
  // The 会 of the QR: joined on the map once the account is there (map.js joinFromInvite).
  if (post) saveInviteJoin(browserStorage(), post, Date.now(), hold);
  clearPendingInvite(browserStorage());
  // Roles and slugs come from the database; the name is already on screen.
  await refreshCommunities();
  if (waits) await refreshJoinStatus();
  return claimed;
}

/**
 * Right after a sign-in: claim the invite that is waiting, if any, then say whether
 * this person may go on. `account` is the account row (null for somebody new).
 *   { blocked: false }                 carry on
 *   { blocked: true, message }         they were signed out: no invite, and accounts need one
 */
export async function settleSession(account) {
  if (!communitiesActive() || !session.signedIn()) return { blocked: false };
  const pending = readPendingInvite(browserStorage());
  let claimed = false;
  let failure = '';
  // The network (or the server) failed, so we do not know: nobody is turned away for that.
  let unsure = false;
  if (pending) {
    try {
      const community = await claimInvite(pending);
      claimed = true;
      toast(claimedIn(community)
        ? `${community.name || 'コミュニティ'} に参加しました`
        : `「${community.name || 'コミュニティ'}」に申し込みました`);
    } catch (error) {
      if (transientFailure(error)) {
        // The invite stays; the next load tries again. The database still refuses a new
        // account without an invite, so nothing is let through by waiting.
        unsure = true;
        failure = RETRY_LATER_NOTE;
      } else {
        clearPendingInvite(browserStorage());
        failure = error.message;
        await refreshCommunities();   // are they in one already?
      }
    }
  } else {
    await refreshCommunities();
  }
  // Somebody who claimed earlier and never finished their profile is already in a
  // community; they are not turned away. Neither is somebody whose list could not be read.
  if (!claimed && !state.communitiesLoaded) unsure = true;
  const member = state.communities.length > 0;
  if (!unsure && registrationBlocked({ cfg: config(), hasAccount: Boolean(account), claimed: claimed || member })) {
    session.signOut();
    state.account = null;
    dropCommunities();
    window.dispatchEvent(new Event('islands:signout'));
    return { blocked: true, message: failure || NEW_ACCOUNT_NOTE };
  }
  if (failure) toast(failure);
  return { blocked: false };
}

// ---------------------------------------------------------------- the screen

export function setupInvite() {
  let shown = 0;

  const hideButtons = () => {
    ['inviteJoin', 'inviteRegister', 'inviteLogin', 'inviteHome', 'inviteReturning', 'inviteLegal', 'inviteJoinNote', 'inviteDisclose', 'inviteConsent']
      .forEach((id) => { $(id).hidden = true; });
    clear($('inviteOAuth'));
  };

  // "What the admin sees": a box of words before the account is made; for somebody signed in, their own card.
  function paintDisclosure(showCard) {
    const box = clear($('inviteDisclose'));
    if (showCard) {
      const mail = session.email();
      box.append(
        el('p', { className: 'invite-disclose-label', text: '管理者に見える内容' }),
        el('div', { className: 'waiting-card' },
          avatar(state.account, 48),
          el('div', { className: 'waiting-card-text' },
            el('span', { className: 'waiting-card-name', text: state.account.display_name }),
            el('span', { className: 'waiting-card-sub', text: state.account.affiliation || '' }),
            mail ? el('span', { className: 'waiting-card-sub', text: mail }) : null)),
        el('p', { className: 'waiting-fine', text: ADMIN_SEES_BOX.join('') }));
    } else {
      box.append(el('div', { className: 'invite-disclose-box' }, ADMIN_SEES_BOX[0], el('span', { text: ADMIN_SEES_BOX[1] })));
    }
    box.hidden = false;
  }

  // The words about agreeing (E 19): the new terms, at /terms/next and /privacy/next.
  function paintConsent(signedIn) {
    const note = clear($('inviteConsent'));
    if (signedIn) {
      note.textContent = CONSENT_AFTER_PRESS;
    } else {
      note.append('続けると、上のことと、',
        el('a', { text: '利用規約', attrs: { href: '/terms/next', target: '_blank', rel: 'noopener' } }), 'と',
        el('a', { text: 'プライバシーポリシー', attrs: { href: '/privacy/next', target: '_blank', rel: 'noopener' } }),
        'に同意したことになります。');
    }
    note.hidden = false;
  }

  async function render(params, query) {
    const turn = ++shown;
    const code = params.code;
    const post = query ? query.get('post') : null;
    hideButtons();
    $('inviteError').textContent = '';
    $('inviteTitle').textContent = '招待を確認しています';
    $('inviteLede').textContent = '';

    if (!communitiesActive()) {
      // The code can ship before the tables exist; an invite means nothing then.
      await navigate('#/welcome', { replace: true });
      return;
    }

    let check = null;
    if (validInviteCode(code)) {
      try {
        check = readInviteCheck(await data.checkInvite(code));
      } catch {
        check = null;
      }
    } else {
      check = readInviteCheck({ valid: false, reason: 'unknown' });
    }
    if (turn !== shown) return;

    const view = inviteView(check);
    $('inviteTitle').textContent = view.title;
    $('inviteLede').textContent = view.lede;
    $('invite').dataset.state = view.state;

    // The 会 of the QR is joined too: say so before anything is pressed. Only a member can read the post;
    // anybody else is told without its name (community-rules inviteJoinNote).
    if (view.state === 'valid' && validPostId(post)) {
      const meeting = session.signedIn() ? await data.getPost(post).catch(() => null) : null;
      if (turn !== shown) return;
      const note = inviteJoinNote({
        post, meeting, open: !meeting || (isRecruiting(meeting) && !recruitState(meeting)),
      });
      $('inviteJoinNote').textContent = note || '';
      $('inviteJoinNote').hidden = !note;
    }

    const signedIn = session.signedIn();
    const hasAccount = Boolean(state.account);
    const named = Boolean(state.account && state.account.display_name);
    const approval = view.state === 'valid' && view.approval === true;
    const actions = inviteActions({
      valid: view.state === 'valid', signedIn, providers: config().oauth || [],
    });

    // Kept only when a person presses register / log in / Google (they are about to leave the
    // page or sign in): merely opening the link must not leave an invite behind that the next
    // person to sign in on this device would silently use.
    const keep = () => savePendingInvite(browserStorage(), { code, post });

    actions.providers.forEach((provider) => $('inviteOAuth').append(el('button', {
      className: `btn btn-block ${OAUTH_NAMES[provider]?.className || ''}`,
      attrs: { type: 'button' },
      text: OAUTH_NAMES[provider]?.label || `${provider}で登録`,
      on: { click: () => { keep(); session.startOAuth(provider); } },
    })));
    $('inviteRegister').textContent = actions.providers.length ? 'メールアドレスで登録' : 'メールで登録';
    $('inviteLogin').textContent = 'ログイン';
    $('inviteJoin').textContent = 'このコミュニティに参加する';
    if (approval) {
      // A link that needs an admin's approval: say what the admin will see before anything is pressed.
      $('inviteRegister').textContent = actions.providers.length ? 'メールアドレスで申し込む' : '参加を申し込む';
      $('inviteLogin').textContent = 'ログインして申し込む';
      $('inviteJoin').textContent = '参加を申し込む';
      paintDisclosure(signedIn && named);
    }
    $('inviteRegister').classList.toggle('is-apply', approval);
    $('inviteJoin').classList.toggle('is-apply', approval);
    $('inviteRegister').hidden = !actions.register;
    $('inviteReturning').hidden = !actions.login;
    $('inviteLogin').hidden = !actions.login;
    $('inviteLegal').hidden = !actions.register || approval;
    $('inviteJoin').hidden = !actions.join;
    // Signed in, the 申し込み page has a way back as well (the image): the first screen.
    $('inviteHome').hidden = view.state === 'valid' && !(approval && signedIn);
    if (approval) paintConsent(signedIn);
    $('inviteHome').onclick = () => navigate(signedIn && hasAccount ? '#/map' : '#/welcome');
    $('inviteRegister').onclick = () => { keep(); navigate('#/auth?intent=register'); };
    $('inviteLogin').onclick = () => { keep(); navigate('#/auth?intent=login'); };
    $('inviteJoin').onclick = async () => {
      $('inviteJoin').disabled = true;
      $('inviteError').textContent = '';
      try {
        // Signed in but never finished the profile: join, then go on to name and photo (the post
        // that came with the invite waits and opens at the end, like for a new person).
        const community = await claimInvite({ code, post }, { holdPost: !hasAccount });
        if (!claimedIn(community)) {
          // Applied, not in yet: finish the name first if there is none; then wait (somebody who is in another
          // community simply goes on to its map: the switcher says 「（承認待ち）」).
          toast(`「${community.name || 'コミュニティ'}」に申し込みました`);
          if (!named) navigate('#/setup');
          else navigate(state.communities.length ? '#/map' : '#/waiting');
          return;
        }
        toast(`${community.name || 'コミュニティ'} に参加しました`);
        if (!hasAccount) navigate('#/setup');
        else navigate(post ? mapLinkFor(post) : '#/map');
      } catch (error) {
        $('inviteError').textContent = error.message;
      } finally {
        $('inviteJoin').disabled = false;
      }
    };
  }

  screen('invite', { enter: render });
}
