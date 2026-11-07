// Ground textures built off the page's thread, in terrain-worker.js (2026-10-16).
//
// Built on the page, every stop after a pan or a pinch froze the map for about
// 0.2 s on a desktop and close to a second on a phone. Here a job is posted and
// the map keeps drawing what it has; the pixels come back and only go onto a
// canvas on the page. When a worker cannot start, errors, or does not answer,
// every caller builds on the page as before.
//
// Since 2026-11-02 there are several workers (one per spare core, 4 at most), and
// the sharp texture of map plan B is cut into strips that they make at the same
// time (offThreadDetail): on a phone this is what brings it back in well under a
// second after a zoom instead of a few.

import { config } from '../config.js';
import { extentB, islandBForWorker, mapBOn } from './island-b.js';
import { detailPlan } from './terrain.js';

// No answer by then: give up on the workers for a while (RETRY_MS). A job goes to a worker
// only when it is idle (below), so this counts only the time a job is actually
// being made: two jobs asked for together on a slow phone are not a dead worker.
const PATIENCE_MS = 5000;
const MAX_WORKERS = 4;

let broken = false;
let brokenAt = 0;
const RETRY_MS = 60000;     // after giving up, workers are tried again this much later
const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
// A page in the background has its timers and workers stopped: the time it spends
// there is not the worker's fault, so a job's patience starts again when it comes back.
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', () => {
    if (hidden()) return;
    const now = Date.now();
    slots.forEach((slot) => { if (slot.busy) slot.deadline = now + PATIENCE_MS; });
  });
}
let next = 0;
const waiting = new Map();  // job id -> answer(built, ok)
let queue = [];             // jobs not yet posted: { id, kind, job }
const slots = [];           // { worker, busy (id of its job, 0 when idle), given, givenB }

/** How many workers the sharp texture may use: one core stays for the page. */
export function workerCount() {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  return Math.max(1, Math.min(MAX_WORKERS, cores - 1));
}

function spawn() {
  const slot = { worker: null, busy: 0, given: null, givenB: null };
  slot.worker = new Worker(new URL('./terrain-worker.js', import.meta.url), { type: 'module' });
  slot.worker.onerror = giveUp;   // e.g. a browser without module workers
  slot.worker.onmessage = ({ data }) => {
    const answer = waiting.get(data.id);
    if (!answer) return;
    waiting.delete(data.id);
    if (slot.busy === data.id) slot.busy = 0;
    if (data.error) {
      answer(null, false);
      giveUp();
      return;
    }
    answer(data.built, true);
    pump();   // after the answer, which may ask for the next job
  };
  slots.push(slot);
  return slot;
}

/** A worker for a job of `kind`, or null when there is none to spare. The whole-map
 * ground (long, and rarely asked for) only ever takes the first worker, so the
 * others stay free for the sharp texture, which is what is being looked at; the
 * sharp texture takes the last idle one first, leaving the first for the ground. */
function freeSlot(kind) {
  if (kind === 'ground') {
    if (!slots.length) return open();
    return slots[0].busy ? null : slots[0];
  }
  for (let at = slots.length - 1; at >= 0; at -= 1) if (!slots[at].busy) return slots[at];
  return slots.length < workerCount() ? open() : null;
}

/** A new worker, or null if the browser would not start one. */
function open() {
  try {
    return spawn();
  } catch {
    return null;   // the jobs wait for the workers there are
  }
}

/** Post queued jobs to idle workers. The sharp texture ('detail', 'strip',
 * 'surf') goes before a whole-map one ('ground') that is still waiting: it is
 * what the person is looking at. */
function pump() {
  while (queue.length && !broken) {
    const first = queue.findIndex((entry) => entry.kind !== 'ground');
    const at = first < 0 ? 0 : first;
    const slot = freeSlot(queue[at].kind);
    if (!slot) return;
    const { id, kind, job } = queue.splice(at, 1)[0];
    slot.busy = id;
    slot.deadline = Date.now() + PATIENCE_MS;
    const watch = () => {
      if (slot.busy !== id) return;
      const left = slot.deadline - Date.now();
      if (hidden() || left > 0) setTimeout(watch, Math.max(250, left));
      else giveUp();
    };
    setTimeout(watch, PATIENCE_MS);
    const current = config();
    // Map plan B: the island goes once (when its payload object changes), the view
    // whenever its text changes; nothing at all when plan B is not in use.
    const shared = islandBForWorker();
    let islandB = null;
    if (shared) {
      const text = JSON.stringify(shared.view);
      if (!slot.givenB || slot.givenB.payload !== shared.payload || slot.givenB.text !== text) {
        islandB = { payload: slot.givenB && slot.givenB.payload === shared.payload ? null : shared.payload, view: shared.view };
        slot.givenB = { payload: shared.payload, text };
      }
    }
    slot.worker.postMessage({ id, kind, config: current === slot.given ? null : current, job, islandB });
    slot.given = current;
  }
}

function giveUp() {
  broken = true;
  brokenAt = Date.now();
  slots.forEach((slot) => slot.worker.terminate());
  slots.length = 0;
  const answers = [...waiting.values()];
  waiting.clear();
  queue = [];
  answers.forEach((answer) => answer(null, false));
}

/** Only what the ground is made of: energyOf, radiusOf and coastOf read these. */
function plain(posts) {
  return posts.map(({ id, x, y, energy, motivation, like_count, help_count, join_count, comment_count }) => (
    { id, x, y, energy, motivation, like_count, help_count, join_count, comment_count }));
}

/**
 * Build `kind` ('ground', 'detail', 'strip' or 'surf', see terrain-worker.js)
 * from `job` in a worker. `answer(built, ok)` is called once: `ok` false means
 * the worker failed and the caller should build on the page. Returns false,
 * without calling `answer`, when there is no worker to ask.
 */
export function offThread(kind, job, answer) {
  if (broken && brokenAt && Date.now() - brokenAt > RETRY_MS) broken = false;   // try the workers again
  if (broken || typeof Worker === 'undefined') return false;
  if (!slots.length) {
    try {
      spawn();
    } catch {
      broken = true;
      return false;
    }
  }
  const id = ++next;
  waiting.set(id, answer);
  queue.push({ id, kind, job: { ...job, posts: plain(job.posts) } });
  pump();
  return true;
}

let warmed = false;

/**
 * Wake the workers for the sharp texture before it is asked for: a worker just
 * started runs its code slowly until it has run it a few thousand times, and
 * has to be handed the island; a small job on each does both, in the background.
 * Once, when map plan B is in use.
 */
export function offThreadWarm() {
  if (warmed || broken || typeof Worker === 'undefined') return;
  const ext = extentB();
  if (!ext || !islandBForWorker() || !mapBOn(config())) return;
  warmed = true;
  const cx = (ext.minX + ext.maxX) / 2;
  const cy = (ext.minY + ext.maxY) / 2;
  const region = { minX: cx - 50, minY: cy - 50, maxX: cx + 50, maxY: cy + 50 };
  for (let round = 0; round < 3; round += 1) {
    for (let n = 0; n < workerCount(); n += 1) {
      offThread('detail', { posts: [], cells: [], region, scale: 4, pixelRatio: 1, surf: false }, () => {});
    }
  }
}

/**
 * The sharp texture (terrain.js detailPixels' answer, with the surf when the job
 * asks for it). Map plan B's is cut into strips made by all the workers at once
 * and put together here; any other goes to one worker whole. Same contract as
 * offThread.
 */
export function offThreadDetail(job, answer) {
  if (broken || typeof Worker === 'undefined') return false;
  const count = workerCount();
  const plan = count > 1 ? detailPlan({ region: job.region, scale: job.scale, pixelRatio: job.pixelRatio, parts: Math.ceil(count * 1.5) }) : null;
  if (!plan) return offThread('detail', job, answer);

  const { width, height } = plan;
  const pixels = new Uint8ClampedArray(width * height * 4);
  let left = plan.strips.length + (job.surf ? 1 : 0);
  let coast = null;
  let failed = false;
  const part = (built, ok) => {
    if (failed) return;
    if (!ok || !built) {
      failed = true;
      answer(null, false);
      return;
    }
    if (built.pixels) pixels.set(built.pixels, built.rowFrom * width * 4);
    else coast = built.coast;
    left -= 1;
    if (left === 0) answer({ pixels, minX: plan.minX, minY: plan.minY, scale: plan.scale, width, height, coast }, true);
  };
  // The surf first: it is the longest single piece and nothing else waits on it.
  // (The first call is the one that can find there is no worker: then nothing was queued.)
  if (job.surf) {
    if (!offThread('surf', job, part)) return false;
  }
  for (const strip of plan.strips) {
    if (!offThread('strip', { ...job, surf: false, strip }, part) && !failed) return false;
  }
  return true;
}
