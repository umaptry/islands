// Map plan B: one community, one big island (2026-10-31).
//
// The server sends the island once (GET /api/map-b/base): a coarse grid of the
// signed distance to the coast (inland is positive), the 16 regions, and the
// cells close to the hand-made reference points. This module only holds and
// reads it. It is pure (no DOM, no imports), so the page, the ground worker and
// the tests can all load it; the worker is handed the same payload and view
// (offthread.js) and calls setIslandB / setIslandBView itself.
//
// World units are the production ones. The prototype F (read-only reference)
// was drawn in units 2.5 times smaller; every distance below that came from it
// is multiplied by 2.5.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

let data = null;      // decoded payload, or null
let raw = null;       // the payload as it came, to hand to the worker
let view = { communityKey: null, postTotal: 0, forest: null, mapParam: null };
let seed = null;      // the community's own numbers for the coast, from its key

function decode(text, Type) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return Type === Int8Array ? new Int8Array(bytes.buffer) : bytes;
}

/** Hold the island payload (or forget it with null). */
export function setIslandB(payload) {
  if (!payload || !payload.grid) {
    data = null;
    raw = null;
    return;
  }
  const { grid } = payload;
  const n = grid.n;
  const coastBytes = decode(payload.coast, Int8Array);
  const coast = new Float32Array(n * n);
  for (let i = 0; i < coast.length; i += 1) coast[i] = (coastBytes[i] || 0) * 4;
  raw = payload;
  data = {
    version: payload.version ?? null,
    x0: grid.x0,
    y0: grid.y0 ?? grid.x0,
    cell: grid.cell,
    n,
    coast,
    region: decode(payload.region, Uint8Array),
    near: decode(payload.near, Uint8Array),
    regions: payload.regions || [],
    start: payload.start || null,
    extent: payload.extent || null,
    forest: payload.forest === 'mass' ? 'mass' : 'grove',
    nearAny: null,
  };
  // Which grid cells have a reference point near any corner: elsewhere the
  // `near` read is exactly 0, so coastCore skips it.
  const any = new Uint8Array(n * n);
  const nearGrid = data.near;
  for (let j = 0; j < n - 1; j += 1) {
    for (let i = 0; i < n - 1; i += 1) {
      const k = j * n + i;
      any[k] = nearGrid[k] || nearGrid[k + 1] || nearGrid[k + n] || nearGrid[k + n + 1] ? 1 : 0;
    }
  }
  data.nearAny = any;
}

/** The decoded island, or null when none is held. */
export const islandB = () => data;

/** The payload as it was given (for the worker). */
export const islandBPayload = () => raw;

function hashText(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** { communityKey, postTotal, forest, mapParam }: what the ground depends on
 * besides the island. Missing keys are left as they were. */
export function setIslandBView(next = {}) {
  view = { ...view, ...next };
  seed = view.communityKey ? 1 + hashText(String(view.communityKey)) * 3 : null;
}
export const islandBView = () => view;

// Posts stand on land whatever the shaken coast says: within POST_SAFE of a
// post the coast is at least 8, as it is near the reference points. Kept in
// buckets of the same size, so coastAt looks at nine of them.
const POST_SAFE = 12;
let postBuckets = new Map();
const bucketKey = (i, j) => i * 100003 + j;
/** The posts' places (anything with x and y); replaces the earlier ones. */
export function setIslandBPosts(points) {
  postBuckets = bucketsOf(points);
}
function bucketsOf(points) {
  const map = new Map();
  for (const p of points || []) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const key = bucketKey(Math.floor(p.x / POST_SAFE), Math.floor(p.y / POST_SAFE));
    const list = map.get(key);
    if (list) list.push(p.x, p.y); else map.set(key, [p.x, p.y]);
  }
  return map;
}
// The distance from (x, y) to the closest post in `map`, looking no further
// than `reach` (Infinity when none is that close).
function postDistance(x, y, map, reach) {
  if (!map.size) return Infinity;
  const bi = Math.floor(x / POST_SAFE);
  const bj = Math.floor(y / POST_SAFE);
  // The posts in the buckets round (bi, bj), gathered once per bucket: a pixel
  // row stays in one bucket for many pixels, so the Map is not asked 25 times
  // for each of them. Same posts, same minimum.
  let near = map.near;
  if (!near || near.bi !== bi || near.bj !== bj || near.reach !== reach) {
    const span = Math.ceil(reach / POST_SAFE);
    const flat = [];
    for (let j = bj - span; j <= bj + span; j += 1) {
      for (let i = bi - span; i <= bi + span; i += 1) {
        const list = map.get(bucketKey(i, j));
        if (list) for (let k = 0; k < list.length; k += 1) flat.push(list[k]);
      }
    }
    near = { bi, bj, reach, flat };
    map.near = near;
  }
  const { flat } = near;
  if (!flat.length) return Infinity;
  let best = reach * reach;
  let found = false;
  for (let k = 0; k < flat.length; k += 2) {
    const d2 = (flat[k] - x) ** 2 + (flat[k + 1] - y) ** 2;
    if (d2 <= best) { best = d2; found = true; }
  }
  return found ? Math.sqrt(best) : Infinity;
}

/** Both pieces for the worker, or null; the page's own `?map=` rides along
 * because a worker cannot see the page's address. */
export function islandBForWorker() {
  if (!raw) return null;
  return { payload: raw, view: { ...view, mapParam: mapParamNow() ?? view.mapParam } };
}

/** What would change the ground, as one string (cache keys). */
export function islandBKey() {
  if (!data) return '';
  return [data.version, view.communityKey, view.postTotal, forestMode(), view.roadsKey || ''].join('|');
}

/** 'mass' (one canopy, the default) or 'grove' (trees one by one: only when the payload or the view asks). */
export function forestMode() {
  if (view.forest === 'mass' || view.forest === 'grove') return view.forest;
  return data ? data.forest : 'mass';
}

// ---- the map=b switch

function addressParam(name, place) {
  if (!place) return null;
  const before = new URLSearchParams(place.search || '').get(name);
  if (before !== null) return before;
  const hash = String(place.hash || '');
  const at = hash.indexOf('?');
  return at < 0 ? null : new URLSearchParams(hash.slice(at + 1)).get(name);
}
const remembered = new Map();
/** A preview switch in the page's address (`?map=`, `?forest=`, `?roads=`,
 * before or after the `#`), remembered: signing in and moving between screens
 * rewrite the address and drop it, so once seen it holds until the page is
 * loaded again (like ?tod). */
export function previewParam(name, place = (typeof location !== 'undefined' ? location : null)) {
  const found = addressParam(name, place);
  if (found !== null) remembered.set(name, found);
  return remembered.has(name) ? remembered.get(name) : null;
}

/** The page's `?map=`, remembered (previewParam). The screen hands this to
 * setIslandBView({ mapParam }). */
export function mapParamNow(place = (typeof location !== 'undefined' ? location : null)) {
  return previewParam('map', place);
}

/** Is plan B on? The island has to be here, and either the server's switch
 * (features.map_b) or `?map=b` in the page's address is set. */
export function mapBOn(cfg, place) {
  if (!data) return false;
  if (cfg && cfg.features && cfg.features.map_b) return true;
  return mapParamNow(place) === 'b' || view.mapParam === 'b';
}

// ---- reading the grid

// (The bilinear read of the coast and reference grids is inlined in coastCore.)

function ih(x, y) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** noise() that remembers the lattice cell it last read: a map pixel row moves
 * through a cell for many pixels, so the four corner hashes are read once per
 * cell instead of once per pixel. The numbers are exactly noise()'s. */
export function memoNoise() {
  let cx = NaN;
  let cy = NaN;
  let a = 0;
  let b = 0;
  let c = 0;
  let d = 0;
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi !== cx || yi !== cy) {
      cx = xi;
      cy = yi;
      a = ih(xi, yi);
      b = ih(xi + 1, yi);
      c = ih(xi, yi + 1);
      d = ih(xi + 1, yi + 1);
    }
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}
const coastNoiseBig = memoNoise();
const coastNoiseSmall = memoNoise();

/** The signed distance to the coast at world (x, y): positive inland. With a
 * communityKey the coast is that community's own: bays and capes that fade out
 * offshore (no stray shoals) and inland (the middle is left alone). Cells close
 * to the reference points never go below 8, so a post cannot fall into the sea;
 * the land round them slopes gently down to the shore. */
export function coastAt(x, y) {
  return coastCore(x, y, null);
}

/** coastAt that also guards `points` (and the registered posts), without
 * touching the registered list: for a calculation that was handed some posts. */
export function coastWithPosts(points) {
  const extra = bucketsOf(points);
  return (x, y) => coastCore(x, y, extra);
}

function coastCore(x, y, extra) {
  if (!data) return -1000;
  // One look-up of the grid cell for both the coast and the reference points
  // (they share their grid): the bilinear read is gridAt's, done once.
  const { x0, y0, cell, n } = data;
  const fx = clamp((x - x0) / cell - 0.5, 0, n - 1.001);
  const fy = clamp((y - y0) / cell - 0.5, 0, n - 1.001);
  const gi = fx | 0;
  const gj = fy | 0;
  const gu = fx - gi;
  const gv = fy - gj;
  const gk = gj * n + gi;
  const arr = data.coast;
  let c = (arr[gk] * (1 - gu) + arr[gk + 1] * gu) * (1 - gv) + (arr[gk + n] * (1 - gu) + arr[gk + n + 1] * gu) * gv;
  if (seed !== null && c <= 100) {
    const w = clamp((c + 62) / 50, 0, 1);
    if (w > 0) {
      c += w * (85 * (coastNoiseBig(x * 0.008 + seed * 31.7, y * 0.008 + seed * 11.3) - 0.62)
        + 20 * (coastNoiseSmall(x * 0.024 + seed * 5, y * 0.024) - 0.5));
    }
  }
  if (c >= 8) return c;
  // Raised round the reference points and the posts, sloping down to the sea
  // (a hard step would show their cells and circles as square capes). Inside a
  // near cell the bilinear weight is at least 0.25, which gives 8; the shore
  // is most of a cell out. Round a post: 8 within POST_SAFE, the shore
  // POST_SAFE further out. Further away nothing changes.
  if (data.nearAny[gk] === 1) {
    const nr = data.near;
    const w = (nr[gk] * (1 - gu) + nr[gk + 1] * gu) * (1 - gv) + (nr[gk + n] * (1 - gu) + nr[gk + n + 1] * gu) * gv;
    if (w > 0) c = Math.max(c, 48 * w - 4);
  }
  const d = Math.min(postDistance(x, y, postBuckets, 2 * POST_SAFE), extra !== null ? postDistance(x, y, extra, 2 * POST_SAFE) : Infinity);
  if (d < Infinity) c = Math.max(c, 8 * (2 - d / POST_SAFE));
  return c;
}

export const isLandB = (x, y) => coastAt(x, y) > 0;

/** The region (0-15) at world (x, y); 255 outside the land. */
export function regionAt(x, y) {
  if (!data) return 255;
  const { x0, y0, cell, n } = data;
  const i = clamp(Math.floor((x - x0) / cell), 0, n - 1);
  const j = clamp(Math.floor((y - y0) / cell), 0, n - 1);
  return data.region[j * n + i];
}

export const regionsB = () => (data ? data.regions : []);
export const startB = () => (data ? data.start : null);
export const extentB = () => (data ? data.extent : null);
