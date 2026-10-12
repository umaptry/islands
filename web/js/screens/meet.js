// What changed on the map while you were away (段4): the pill and its sheet.
//
// Wired from screens/map.js with setupMeet() rather than importing it, so the
// two screens do not import each other.

import { api } from '../net.js';
import { state } from '../state.js';
import {
  $, avatar, clear, desktopSheet, el, openSheet, timeAgo,
} from '../ui.js';
import { focusOn } from '../map/index.js';
import { describeChange, digestLabel } from '../meet-text.js';

const SEEN_KEY = 'islands.seenChanges';
let digestFor = null; // the account the digest was fetched for, once a session
let changes = [];
let seen = readSeen();

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

/** Open one of this module's sheets. */
function meetSheet() {
  const body = openSheet({});
  clear($('sheetFoot'));
  return { body: clear(body) };
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
  pill.hidden = !left.length || !state.account;
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

export function setupMeet() {
  $('mapDigest').addEventListener('click', openDigest);
}
