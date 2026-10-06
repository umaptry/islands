// Meeting people (段4): the 「似ている人」 button and its list, a person's card,
// and what changed on the map while you were away.
//
// Wired from screens/map.js with setupMeet({ openPost, react }) rather than
// importing it, so the two screens do not import each other.

import { api } from '../net.js';
import { hasReacted, state } from '../state.js';
import {
  $, avatar, clear, clip, desktopSheet, el, openSheet, timeAgo,
} from '../ui.js';
import { focusOn } from '../map/index.js';
import { describeChange, digestLabel, personMeta, reasonLine } from '../meet-text.js';

const SEEN_KEY = 'islands.seenChanges';
let hooks = { openPost: () => {}, react: async () => {} };
let digestFor = null; // the account the digest was fetched for, once a session
let changes = [];
let seen = readSeen();
let sheetToken = 0;   // which of this module's sheets is open, if any

/** Where a point should land while a sheet covers part of the screen. */
const lift = () => (desktopSheet() ? 0.5 : 0.3);

function readSeen() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function markSeen(id) {
  seen.add(id);
  try {
    // Only the newest ids matter: the digest never repeats an old change.
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-60)));
  } catch {
    /* private window: the ring goes for this visit only */
  }
  paintMarks();
}

function faces(people, size) {
  return el('span', { className: 'face-stack' }, ...people.map((person) => avatar(person, size)));
}

/** Open one of this module's sheets; closing it clears the person highlight. */
function meetSheet() {
  const token = ++sheetToken;
  const body = openSheet({ onClose: () => {
    if (token !== sheetToken) return;
    sheetToken = 0;
    state.focusPerson = null;
  } });
  clear($('sheetFoot'));
  return { body: clear(body), token };
}

// ---------------------------------------------------------------- similar people

/** The bottom-left button: shown on the map view when there is somebody to meet. */
export function paintPeople() {
  const button = $('mapPeople');
  const people = state.similar || [];
  if (!state.account || state.view !== 'map' || !people.length) {
    button.hidden = true;
    return;
  }
  button.hidden = false;
  const label = `似ている人 ${people.length}人`;
  button.setAttribute('aria-label', label);
  clear(button).append(
    faces(people.slice(0, 2), 24),
    el('span', { className: 'people-label', text: label }),
    el('span', { className: 'people-count num', text: String(people.length), attrs: { 'aria-hidden': 'true' } }),
  );
}

function openPeople() {
  const { body } = meetSheet();
  state.focusPerson = null;
  body.append(el('h3', { className: 'meet-title', text: 'あなたに似ている人' }));
  const list = el('div', { className: 'person-list' });
  (state.similar || []).forEach((person) => {
    list.append(el('button', {
      className: 'person-row',
      attrs: { type: 'button' },
      on: { click: () => openPerson(person) },
    },
    avatar(person, 40),
    el('span', { className: 'person-row-text' },
      el('span', { className: 'person-row-name', text: person.display_name || '名前なし' }),
      el('span', { className: 'person-row-reason', text: reasonLine(person) }),
      // The island on its own line unless the reason already names it.
      person.island && !reasonLine(person).includes(person.island)
        ? el('span', { className: 'person-row-island', text: person.island }) : null,
    )));
  });
  body.append(list);
}

async function openPerson(person) {
  state.focusPerson = person.id;
  if (person.post) focusOn(person.post, { lift: lift() });
  const { body, token } = meetSheet();
  state.focusPerson = person.id;
  body.append(backLink(), el('p', { className: 'sheet-loading', text: '読み込み中…' }));
  let card;
  try {
    card = await api.get(
      `/api/people/${encodeURIComponent(person.id)}/card?viewer=${encodeURIComponent(state.account.id)}`,
      { auth: false },
    );
  } catch (error) {
    if (token !== sheetToken) return;
    clear(body).append(backLink(), el('p', { className: 'sheet-error', text: error.message }));
    return;
  }
  if (token !== sheetToken) return;
  paintCard(clear(body), card);
}

function backLink() {
  return el('button', {
    className: 'meet-back',
    attrs: { type: 'button' },
    text: '‹ 似ている人の一覧',
    on: { click: openPeople },
  });
}

function paintCard(body, card) {
  const { person, latest_post: latest } = card;
  body.append(backLink());
  body.append(el('div', { className: 'person-head' },
    avatar(person, 52),
    el('div', { className: 'person-head-text' },
      el('div', { className: 'person-name', text: person.display_name || '名前なし' }),
      el('div', { className: 'person-meta', text: personMeta(card) }),
    ),
  ));
  if (card.reasons?.length) {
    body.append(el('div', { className: 'reason-list' },
      ...card.reasons.map((reason) => el('span', { className: 'reason-chip', text: reason.text }))));
  }
  if (person.bio) body.append(el('p', { className: 'person-bio', text: person.bio }));
  const wants = [['探している', person.seeking], ['手伝える', person.offering]].filter(([, text]) => text);
  if (wants.length) {
    body.append(el('dl', { className: 'person-wants' },
      ...wants.flatMap(([term, text]) => [el('dt', { text: term }), el('dd', { text })])));
  }
  if (latest) {
    body.append(el('button', {
      className: 'person-latest',
      attrs: { type: 'button' },
      on: { click: () => hooks.openPost(latest.id) },
    },
    el('span', { className: 'person-latest-label', text: `最新の投稿・${timeAgo(latest.created_at)}` }),
    el('span', { className: 'person-latest-body', text: latest.body })));
  }
  if (card.connections?.length) {
    const more = card.connection_count - card.connections.length;
    body.append(el('div', { className: 'person-links' },
      el('span', { className: 'person-links-label', text: 'よく話す人' }),
      faces(card.connections, 26),
      el('span', {
        className: 'person-links-names',
        text: card.connections.slice(0, 2).map((row) => clip(row.display_name || '', 6)).join('、')
          + (card.connections.length > 2 || more > 0 ? ` ほか${card.connection_count - 2}人` : ''),
      }),
    ));
  }
  if (!latest) return;
  const like = el('button', { className: 'btn btn-quiet person-like', attrs: { type: 'button' } });
  const paintLike = () => {
    const on = hasReacted(latest.id, 'like');
    like.classList.toggle('on', on);
    like.textContent = on ? 'いいね済み' : 'いいね';
    like.setAttribute('aria-pressed', String(on));
  };
  paintLike();
  like.addEventListener('click', async () => {
    const pending = hooks.react(latest.id, 'like');
    paintLike();
    await pending;
    paintLike();
  });
  $('sheetFoot').append(el('div', { className: 'person-actions' },
    like,
    el('button', {
      className: 'btn',
      attrs: { type: 'button' },
      text: 'コメントする',
      on: { click: () => hooks.openPost(latest.id, { draft: card.opener || '', expand: true }) },
    }),
  ));
}

// ---------------------------------------------------------------- away digest

/** Once per session after signing in: what changed since last time (Q57: the
 * map still opens whole; this is a pill, never a sheet that opens by itself). */
export async function loadDigest() {
  const me = state.account ? state.account.id : null;
  if (!me || digestFor === me) return;
  digestFor = me;
  try {
    const result = await api.get('/api/changes/digest');
    changes = result.changes || [];
  } catch {
    changes = [];
  }
  paintMarks();
}

function unseen() {
  return changes.filter((change) => !seen.has(change.id));
}

/** The pill under the tabs and the rings on the map, both from what is unseen. */
export function paintMarks() {
  const left = state.account ? unseen() : [];
  const pill = $('mapDigest');
  pill.hidden = !left.length || state.view !== 'map' || !state.account;
  if (!pill.hidden) pill.textContent = digestLabel(left.length);
  state.changeMarks = left.filter((change) => change.place && change.place.cx != null)
    .map((change) => ({ id: change.id, x: change.place.cx, y: change.place.cy }));
}

/** The label of the island at a change's place today, for rows without a name. */
function nameAt(change) {
  const islands = state.islands || [];
  const same = islands.find((island) => change.island_id && island.island_id === change.island_id);
  if (same) return same.label || '';
  const place = change.place;
  if (!place || place.cx == null) return '';
  let best = null;
  islands.forEach((island) => {
    if (island.cx == null) return;
    const distance = Math.hypot(island.cx - place.cx, island.cy - place.cy);
    if (!best || distance < best.distance) best = { distance, label: island.label };
  });
  return best ? best.label || '' : '';
}

function openDigest() {
  const { body } = meetSheet();
  body.append(el('h3', { className: 'meet-title', text: digestLabel(changes.length) }));
  const list = el('div', { className: 'change-list' });
  changes.forEach((change) => {
    const said = describeChange(change, { nameAt: () => nameAt(change) });
    const row = el('button', {
      className: `change-row${seen.has(change.id) ? ' seen' : ''}`,
      attrs: { type: 'button' },
    },
    el('span', { className: 'change-top' },
      said.tag ? el('span', { className: 'change-tag', text: said.tag }) : null,
      el('span', { className: 'change-time', text: timeAgo(change.created_at) }),
    ),
    el('span', { className: 'change-text', text: said.text }),
    said.people ? el('span', { className: 'change-people' },
      faces((change.people || []).slice(0, 2), 20), el('span', { text: said.people })) : null,
    said.numbers ? el('span', { className: 'change-numbers num', text: said.numbers }) : null);
    row.addEventListener('click', () => {
      if (change.place && change.place.cx != null) focusOn({ x: change.place.cx, y: change.place.cy }, { lift: lift() });
      markSeen(change.id);
      row.classList.add('seen');
    });
    list.append(row);
  });
  body.append(list);
}

// ---------------------------------------------------------------- setup

export function setupMeet({ openPost, react }) {
  hooks = { openPost, react };
  $('mapPeople').addEventListener('click', openPeople);
  $('mapDigest').addEventListener('click', openDigest);
}
