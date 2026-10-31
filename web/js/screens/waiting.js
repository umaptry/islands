// The waiting page (#/waiting): somebody who applied to a community that needs an admin's approval, and
// is in no community yet, is held here. The same page says "turned away" (rejected) and "removed". It also
// opens from the community switcher's 「○○（承認待ち）」 for somebody who is in another community.
//
// What it does while the person waits: shows what the admin sees (name, 所属, mail), lets them be told by a
// notification, fix the name and 所属, take the application back, or log out. It looks again every 30
// seconds, when the page comes back into view, and when a join_approved notification arrives (Realtime
// or the poll). When the application was approved, the community is chosen and the map opens (from the
// guidance, for somebody who has not seen it).

import { api, data } from '../net.js';
import { config } from '../config.js';
import { session } from '../session.js';
import { state } from '../state.js';
import { navigate, screen } from '../router.js';
import { $, avatar, clear, confirmAction, el, toast } from '../ui.js';
import { forgetDevice } from '../push.js';
import { openPushCard, pushAskKind, turnOn } from '../push-ask.js';
import { browserStorage } from '../talk.js';
import { mapLinkFor, takePendingPost } from '../return-post.js';
import { chooseCurrent, refreshCommunities, refreshJoinStatus } from '../communities.js';
import { ADMIN_SEES_NOTE, cancelQuestion, waitingView } from '../community-rules.js';
import { nameMax } from '../fullname-rules.js';
import { rowIds } from '../notify-rules.js';

const POLL_MS = 30000;

let timer = 0;
let wanted = null;            // the id asked for by #/waiting?c=<id>
let approvedSeen = '';        // the join_approved rows known, so a new one looks again at once
let checking = null;
let active = false;

/** The entry the page is about: the one asked for, else the first the status list says. */
function currentEntry() {
  const list = Array.isArray(state.joinStatus) ? state.joinStatus : [];
  return list.find((entry) => entry.id === wanted) || list[0] || null;
}

function card() {
  const account = state.account;
  if (!account || !account.display_name) return null;
  const mail = session.email();
  return el('div', { className: 'waiting-card' },
    avatar(account, 48),
    el('div', { className: 'waiting-card-text' },
      el('span', { className: 'waiting-card-name', text: account.display_name }),
      el('span', { className: 'waiting-card-sub', text: account.affiliation || '' }),
      mail ? el('span', { className: 'waiting-card-sub', text: mail }) : null));
}

async function paintPush() {
  const button = $('waitingPush');
  const entry = currentEntry();
  if (!entry || entry.status !== 'pending') { button.hidden = true; return; }
  let kind = null;
  try { kind = await pushAskKind(); } catch { kind = null; }
  button.hidden = !kind || !active;
  button.dataset.kind = kind || '';
}

function paint() {
  const entry = currentEntry();
  const view = waitingView(entry);
  if (!view) return;
  $('waitingTitle').textContent = view.title;
  $('waitingLede').textContent = view.lede;
  $('waitingNote').textContent = view.note;
  $('waitingNote').hidden = !view.note;
  const pending = view.state === 'pending';
  const box = clear($('waitingCard'));
  const mine = pending ? card() : null;
  if (mine) box.append(mine);
  $('waitingCard').hidden = !mine;
  $('waitingSees').textContent = ADMIN_SEES_NOTE;
  $('waitingSees').hidden = !mine;
  $('waitingEdit').hidden = !pending || !state.account;
  $('waitingCancel').hidden = !view.canCancel;
  $('waitingLeave').hidden = !pending;
  $('waitingForm').hidden = true;
  $('waitingError').textContent = '';
  paintPush();
}

/** Approved: that community is the one to look at, and the map opens (from the guidance for a new person). */
async function enterCommunity(entry) {
  chooseCurrent(entry.id);
  toast(`「${entry.name}」に参加できました`);
  const waiting = takePendingPost(browserStorage());
  await navigate(waiting ? mapLinkFor(waiting) : '#/map');
}

/** Look at the server again; when the application was approved, go in. */
function check() {
  if (checking) return checking;
  checking = (async () => {
    const before = currentEntry();
    await refreshJoinStatus();
    if (!active || !Array.isArray(state.joinStatus)) return;
    const after = state.joinStatus.find((entry) => before && entry.id === before.id);
    if (before && before.status === 'pending' && (!after || after.status !== 'pending')) {
      await refreshCommunities();
      if (state.communities.some((entry) => entry.id === before.id)) {
        await enterCommunity(before);
        return;
      }
    }
    if (!currentEntry()) {
      // Nothing is said about this person any more: out of the waiting page.
      navigate('#/map', { replace: true });
      return;
    }
    paint();
  })().finally(() => { checking = null; });
  return checking;
}

/** The notification list was read: a join_approved row that was not there before means look now. */
function onNotifications() {
  if (!active) return;
  const rows = [...state.notifications, ...state.dmNotices].filter((row) => row.type === 'join_approved');
  const signature = rows.flatMap(rowIds).sort().join(',');
  if (signature !== approvedSeen) {
    approvedSeen = signature;
    check();
  }
}

export function setupWaiting() {
  $('waitingLogout').addEventListener('click', async () => {
    $('waitingLogout').disabled = true;
    try { await forgetDevice(); } catch { /* the sign-out goes on */ }
    $('waitingLogout').disabled = false;
    session.signOut();
    state.account = null;
    state.myViews = {};
    state.myPosts = [];
    state.activePostId = null;
    state.quietPost = undefined;
    window.dispatchEvent(new Event('islands:signout'));
    navigate('#/welcome');
  });

  $('waitingCancel').addEventListener('click', async () => {
    const entry = currentEntry();
    if (!entry || entry.status !== 'pending') return;
    const question = cancelQuestion(entry.name);
    if (!await confirmAction({ ...question, confirmLabel: '取り消す', danger: true })) return;
    $('waitingCancel').disabled = true;
    try {
      await data.cancelJoinRequest(entry.id);
      await refreshJoinStatus();
      toast('申し込みを取り消しました');
      // Nothing is waiting any more (the same invite link applies again); anything still said about me stays here.
      if (state.communities.length) {
        navigate('#/map', { replace: true });
      } else if (Array.isArray(state.joinStatus) && state.joinStatus.length) {
        paint();
      } else {
        // In no community and nothing waiting: back to the first screen, signed out. The same link applies again, and
        // the steps they had not finished (the guidance, the first post) wait for them after they are let in.
        session.signOut();
        state.account = null;
        window.dispatchEvent(new Event('islands:signout'));
        navigate('#/welcome', { replace: true });
      }
    } catch (error) {
      $('waitingError').textContent = error.message || '取り消せませんでした。';
    } finally {
      $('waitingCancel').disabled = false;
    }
  });

  $('waitingEdit').addEventListener('click', () => {
    $('waitingName').value = (state.account && state.account.display_name) || '';
    $('waitingName').maxLength = nameMax(config());
    $('waitingAffiliation').value = (state.account && state.account.affiliation) || '';
    $('waitingForm').hidden = false;
    $('waitingEdit').hidden = true;
    $('waitingName').focus();
  });
  $('waitingFormCancel').addEventListener('click', () => {
    $('waitingForm').hidden = true;
    $('waitingEdit').hidden = false;
    $('waitingError').textContent = '';
  });
  $('waitingForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('waitingName').value.trim();
    const affiliation = $('waitingAffiliation').value.trim();
    if (!name || !affiliation) {
      $('waitingError').textContent = '名前と所属を入力してください。';
      return;
    }
    $('waitingFormSave').disabled = true;
    try {
      state.account = (await api.put('/api/account/me', { display_name: name, affiliation })).account;
      toast('直しました');
      paint();
    } catch (error) {
      $('waitingError').textContent = error.message;
    } finally {
      $('waitingFormSave').disabled = false;
    }
  });

  $('waitingPush').addEventListener('click', async () => {
    const kind = $('waitingPush').dataset.kind;
    if (kind === 'ios') { openPushCard('ios', { from: 'list' }); return; }
    $('waitingPush').disabled = true;
    await turnOn();
    $('waitingPush').disabled = false;
    paintPush();
  });

  document.addEventListener('notifications:loaded', onNotifications);
  document.addEventListener('visibilitychange', () => { if (active && !document.hidden) check(); });
  document.addEventListener('push:changed', () => { if (active) paintPush(); });

  screen('waiting', {
    async enter(_params, query) {
      active = true;
      wanted = (query && query.get('c')) || null;
      approvedSeen = '';
      if (!state.account && !session.signedIn()) { navigate('#/welcome', { replace: true }); return; }
      if (currentEntry()) paint();
      clearInterval(timer);
      timer = setInterval(() => { if (!document.hidden) check(); }, POLL_MS);
      await check();
    },
    leave() {
      active = false;
      clearInterval(timer);
      timer = 0;
    },
  });
}
