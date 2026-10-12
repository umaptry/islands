// Notifications the moment they are written (item 22).
//
// Supabase Realtime over a plain WebSocket, for the same reason net.js has no
// supabase-js: a CDN script would be a runtime dependency on somebody else's
// uptime. One channel per signed-in person, INSERTs on notifications filtered
// to them; RLS on the table means the socket only ever carries rows they could
// read anyway. The row itself is not used - an insert only says "read the list
// again", so grouping and read state stay the server's.
//
// While the socket is down the 30-second poll in app.js does the work; live()
// tells it when it may rest. Local mode has no Realtime and simply polls.

import { config, isLocal } from './config.js';
import { session } from './session.js';
import {
  HEARTBEAT_MS, heartbeatFrame, joinFrame, readFrame, retryDelay, socketUrl, tokenFrame, topicFor,
} from './notify-rules.js';

const SETTLE_MS = 300;     // a burst of inserts (one comment can write two rows) reads once
const PROBE_MS = 5000;     // after the page comes back, how long a silent socket gets

let socket = null;
let userId = null;         // whose channel is open, connecting, or waiting to retry
let topic = null;
let joinRef = null;
let ref = 0;
let joined = false;
let token = null;
let beatTimer = 0;
let waitingBeat = null;    // the heartbeat not answered yet
let retryTimer = 0;
let attempts = 0;
let settleTimer = 0;
let arrive = () => {};

export function setupRealtime({ onArrive }) {
  arrive = onArrive;
}

/** Joined and open: new rows arrive by themselves, and the poll can rest. */
export const live = () => joined && socket !== null && socket.readyState === WebSocket.OPEN;

function wanted() {
  if (isLocal() || !session.signedIn()) return null;
  const { url, anon_key: key } = config().supabase || {};
  return url && key ? session.userId() : null;
}

/**
 * Open, keep or close the channel to match who is signed in. Called on boot,
 * on every session change and when the page comes back into view; `probe`
 * then checks a socket the phone may have frozen while it was away.
 */
export function sync({ probe = false } = {}) {
  const uid = wanted();
  if (!uid) {
    close();
    attempts = 0;
    return;
  }
  if (userId === uid && socket) {
    if (probe) check();
    return;
  }
  // Waiting to retry: coming back into view is worth trying now.
  const retrying = userId === uid && Boolean(retryTimer);
  if (retrying && !probe) return;
  close();
  if (!retrying) attempts = 0;
  connect(uid);
}

function connect(uid) {
  const { url, anon_key: key } = config().supabase;
  userId = uid;
  topic = topicFor(uid);
  let ws;
  try {
    ws = new WebSocket(socketUrl(url, key));
  } catch {
    dropped();
    return;
  }
  socket = ws;
  ws.addEventListener('open', async () => {
    if (socket !== ws) return;
    token = await session.accessToken();
    if (socket !== ws) return;
    if (!token) {
      dropped();
      return;
    }
    joinRef = String(++ref);
    send(joinFrame(topic, uid, token, joinRef));
    clearInterval(beatTimer);
    beatTimer = setInterval(heartbeat, HEARTBEAT_MS);
  });
  ws.addEventListener('message', (event) => {
    if (socket === ws) receive(event.data);
  });
  // An error is always followed by a close; that is where it is handled.
  ws.addEventListener('close', () => {
    if (socket === ws) dropped();
  });
}

function receive(text) {
  const frame = readFrame(text, topic, joinRef);
  switch (frame.kind) {
    case 'joined':
      joined = true;
      attempts = 0;
      // Whatever was written while the channel was down came in no frame.
      settle();
      break;
    case 'insert':
      settle();
      break;
    case 'heartbeat':
      if (frame.ref !== null && String(frame.ref) === waitingBeat) waitingBeat = null;
      break;
    case 'failed':
    case 'closed':
      dropped();
      break;
    default:
      break;
  }
}

function settle() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = 0;
    arrive();
  }, SETTLE_MS);
}

async function heartbeat() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  // The last one was never answered: the line is dead even if it looks open.
  if (waitingBeat !== null) {
    dropped();
    return;
  }
  waitingBeat = String(++ref);
  send(heartbeatFrame(waitingBeat));
  // Realtime closes a channel whose token runs out, so hand it each new one.
  const ws = socket;
  const fresh = await session.accessToken();
  if (socket === ws && joined && fresh && fresh !== token) {
    token = fresh;
    send(tokenFrame(topic, fresh, String(++ref)));
  }
}

function check() {
  if (!socket || socket.readyState !== WebSocket.OPEN || waitingBeat !== null) return;
  const asked = String(++ref);
  waitingBeat = asked;
  send(heartbeatFrame(asked));
  setTimeout(() => {
    if (waitingBeat === asked) dropped();
  }, PROBE_MS);
}

function send(frame) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

/** The channel went away: try again, sooner at first and then more patiently. */
function dropped() {
  const uid = userId;
  close();
  if (!uid || wanted() !== uid) return;
  userId = uid;
  retryTimer = setTimeout(() => {
    retryTimer = 0;
    userId = null;
    if (wanted() === uid) connect(uid);
  }, retryDelay(attempts));
  attempts += 1;
  // Between now and the next join the poll is back on; catch up straight away.
  arrive();
}

function close() {
  clearInterval(beatTimer);
  clearTimeout(retryTimer);
  clearTimeout(settleTimer);
  beatTimer = 0;
  retryTimer = 0;
  settleTimer = 0;
  waitingBeat = null;
  joined = false;
  token = null;
  topic = null;
  userId = null;
  const ws = socket;
  socket = null;
  if (ws && ws.readyState <= WebSocket.OPEN) {
    try {
      ws.close(1000);
    } catch {
      // Already going; nothing to tidy.
    }
  }
}
