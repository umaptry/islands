// Ground textures built off the page's thread, in terrain-worker.js (2026-10-16).
//
// Built on the page, every stop after a pan or a pinch froze the map for about
// 0.2 s on a desktop and close to a second on a phone. Here a job is posted and
// the map keeps drawing what it has; the pixels come back and only go onto a
// canvas on the page. When a worker cannot start, errors, or does not answer,
// every caller builds on the page as before.

import { config } from '../config.js';

const PATIENCE_MS = 5000;   // no answer by then: give up on the worker for good

let worker = null;
let broken = false;
let given = null;           // the config object the worker was last handed
let next = 0;
const waiting = new Map();  // job id -> answer(built, ok)

function giveUp() {
  broken = true;
  if (worker) worker.terminate();
  worker = null;
  const answers = [...waiting.values()];
  waiting.clear();
  answers.forEach((answer) => answer(null, false));
}

function start() {
  worker = new Worker(new URL('./terrain-worker.js', import.meta.url), { type: 'module' });
  worker.onerror = giveUp;   // e.g. a browser without module workers
  worker.onmessage = ({ data }) => {
    const answer = waiting.get(data.id);
    if (!answer) return;
    waiting.delete(data.id);
    if (data.error) {
      answer(null, false);
      giveUp();
      return;
    }
    answer(data.built, true);
  };
  given = null;
}

/** Only what the ground is made of: energyOf, radiusOf and coastOf read these. */
function plain(posts) {
  return posts.map(({ id, x, y, energy, motivation, like_count, help_count, join_count, comment_count }) => (
    { id, x, y, energy, motivation, like_count, help_count, join_count, comment_count }));
}

/**
 * Build `kind` ('ground' or 'detail', see terrain-worker.js) from `job` in the
 * worker. `answer(built, ok)` is called once: `ok` false means the worker failed
 * and the caller should build on the page. Returns false, without calling
 * `answer`, when there is no worker to ask.
 */
export function offThread(kind, job, answer) {
  if (broken || typeof Worker === 'undefined') return false;
  try {
    if (!worker) start();
  } catch {
    broken = true;
    return false;
  }
  const id = ++next;
  waiting.set(id, answer);
  setTimeout(() => { if (waiting.has(id)) giveUp(); }, PATIENCE_MS);
  const current = config();
  worker.postMessage({ id, kind, config: current === given ? null : current, job: { ...job, posts: plain(job.posts) } });
  given = current;
  return true;
}
