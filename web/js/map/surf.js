// Incoming surf: thin white lines that follow the coast, drift in from the open
// water and die on the beach, over and over (design 03 "寄せ波", 2026-10-20).
//
// No import, no DOM: the coast is found where the sharp ground is built, in the
// Web Worker (terrain.js -> coastLines), and comes back as a few thousand
// numbers. Per frame the page only moves those points along their normals and
// strokes three paths - nothing is scanned or painted per pixel.
//
// One contour of the distance-to-land field is traced once, at SURF.mid screen
// px from the beach. A line at any other distance is that contour pushed along
// its own normal, so the animation is arithmetic on the points. Points where
// the push would run into other land (a strait, a bay, a neighbour island) are
// recorded as out of range and simply not drawn there.

export const SURF = {
  mid: 18,          // screen px from the land at which the contour is traced
  near: 7,          // a line has died by here (just outside the foam and the pale ring)
  gap: 9,           // screen px between two lines
  lines: 3,
  period: 7,        // seconds for the pattern to move one gap
  width: [1.5, 1.1, 0.9],   // inner to outer, screen px
  alpha: 0.8,
  wobble: 0.9,      // screen px of sway
  step: 3,          // screen px between points of the contour
  reachOut: 20,     // screen px outward / inward that are checked against other land
  reachIn: 13,
  // The lines are for a view about one island wide: the shorter side of the
  // screen, in world units, is `from` wide where they begin to appear and
  // `full` wide where they are all there. (A small island opened with
  // 「島に入る」 is about 60-110 across the screen's short side; the median island
  // is some 40 across.)
  from: 120,
  full: 80,
};

const smooth01 = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 0..1: how much of the surf shows at this zoom. 0 when zoomed out further. */
export function surfShow(scale, width, height) {
  if (!(scale > 0) || !(width > 0) || !(height > 0)) return 0;
  return smooth01(SURF.from, SURF.full, Math.min(width, height) / scale);
}

/** Where one line is and how strong, for the clock. `u` is the position in the
 * cycle (0..1); line j sits j + 1 - u gaps from the beach, so the set of lines
 * at u = 1 is the set at u = 0 shifted by one: the cycle has no seam.
 * Returns { dist, alpha, width } (screen px) - alpha 0 means do not draw. */
export function surfLine(j, u) {
  const q = j + 1 - u;
  // Dies on the beach, comes up out of the sea at the far side; the outer lines
  // are fainter.
  const env = smooth01(0, 0.8, q) * (1 - smooth01(SURF.lines - 0.7, SURF.lines, q));
  const strength = 1 - 0.55 * (q / SURF.lines);
  return {
    q,
    dist: SURF.near + q * SURF.gap,
    alpha: Math.max(0, env * strength) * SURF.alpha,
    width: SURF.width[Math.min(SURF.width.length - 1, Math.max(0, Math.floor(q)))],
  };
}

/** Position in the cycle for a clock in seconds (null: held still, less motion). */
export function surfPhase(time) {
  if (time === null || time === undefined) return 0.4;
  const t = time / SURF.period;
  return t - Math.floor(t);
}

// ---------------------------------------------------------------- finding the coast

/** Bilinear value of `f` at (x, y) in pixel coordinates; NaN outside. */
function sample(f, width, height, x, y) {
  if (!(x >= 0 && y >= 0 && x <= width - 1 && y <= height - 1)) return NaN;
  const x0 = Math.min(width - 2, Math.floor(x));
  const y0 = Math.min(height - 2, Math.floor(y));
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * width + x0;
  return (f[i] * (1 - fx) + f[i + 1] * fx) * (1 - fy) + (f[i + width] * (1 - fx) + f[i + width + 1] * fx) * fy;
}

// Marching squares: for each case, the pairs of cell edges the contour joins.
// Edges are numbered top 0, right 1, bottom 2, left 3; a corner is "far" when
// its distance is over the level; bits a (top-left) 1, b 2, c 4, d 8.
const JOIN = [
  [], [[3, 0]], [[0, 1]], [[3, 1]], [[1, 2]], [[3, 0], [1, 2]], [[0, 2]], [[3, 2]],
  [[3, 2]], [[0, 2]], [[0, 1], [3, 2]], [[1, 2]], [[3, 1]], [[0, 1]], [[3, 0]], [],
];

/** The chains of points where `f` crosses `level`, as arrays of [x, y] in pixel
 * coordinates. Each is { pts, closed }. */
function trace(f, width, height, level) {
  const links = new Map();
  const join = (a, b) => {
    (links.get(a) || links.set(a, []).get(a)).push(b);
    (links.get(b) || links.set(b, []).get(b)).push(a);
  };
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const i = y * width + x;
      const c = (f[i] > level ? 1 : 0) | (f[i + 1] > level ? 2 : 0)
        | (f[i + width + 1] > level ? 4 : 0) | (f[i + width] > level ? 8 : 0);
      if (c === 0 || c === 15) continue;
      // An edge is named by its first corner and its direction: even = along x.
      const edge = [i * 2, (i + 1) * 2 + 1, (i + width) * 2, i * 2 + 1];
      JOIN[c].forEach(([p, q]) => join(edge[p], edge[q]));
    }
  }
  const at = (id) => {
    const base = id >> 1;
    const ex = base % width;
    const ey = (base - ex) / width;
    if (id & 1) return [ex, ey + (level - f[base]) / (f[base + width] - f[base])];
    return [ex + (level - f[base]) / (f[base + 1] - f[base]), ey];
  };
  const seen = new Set();
  const chains = [];
  const walk = (start) => {
    const ids = [];
    let prev = -1;
    let cur = start;
    let closed = false;
    while (cur !== undefined) {
      ids.push(cur);
      seen.add(cur);
      const next = links.get(cur).find((n) => n !== prev && !seen.has(n));
      if (next === undefined) closed = ids.length > 2 && links.get(cur).includes(start);
      prev = cur;
      cur = next;
    }
    chains.push({ pts: ids.map(at), closed });
  };
  // Open chains (cut by the edge of the texture) from their ends first, so they
  // are walked whole; what is left are loops.
  links.forEach((to, id) => { if (to.length === 1 && !seen.has(id)) walk(id); });
  links.forEach((to, id) => { if (!seen.has(id)) walk(id); });
  return chains;
}

/** Evenly spaced points `step` apart along a chain, lightly smoothed. */
function resample({ pts, closed }, step, passes) {
  const n = pts.length;
  const segs = closed ? n : n - 1;
  const cum = [0];
  for (let i = 0; i < segs; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const length = cum[segs];
  const count = Math.max(2, Math.round(length / step));
  let xs = new Float64Array(count + (closed ? 0 : 1));
  let ys = new Float64Array(xs.length);
  let seg = 0;
  for (let k = 0; k < xs.length; k += 1) {
    const d = (k / count) * length;
    while (seg < segs - 1 && cum[seg + 1] < d) seg += 1;
    const a = pts[seg];
    const b = pts[(seg + 1) % n];
    const span = cum[seg + 1] - cum[seg] || 1;
    const t = Math.min(1, Math.max(0, (d - cum[seg]) / span));
    xs[k] = a[0] + (b[0] - a[0]) * t;
    ys[k] = a[1] + (b[1] - a[1]) * t;
  }
  const m = xs.length;
  for (let pass = 0; pass < passes; pass += 1) {
    const sx = new Float64Array(m);
    const sy = new Float64Array(m);
    for (let k = 0; k < m; k += 1) {
      const p = closed ? (k + m - 1) % m : Math.max(0, k - 1);
      const q = closed ? (k + 1) % m : Math.min(m - 1, k + 1);
      const end = !closed && (k === 0 || k === m - 1);
      sx[k] = end ? xs[k] : (xs[p] + 2 * xs[k] + xs[q]) / 4;
      sy[k] = end ? ys[k] : (ys[p] + 2 * ys[k] + ys[q]) / 4;
    }
    xs = sx;
    ys = sy;
  }
  return { xs, ys, closed, length };
}

/**
 * The coast lines for the surf, from a distance-to-land field.
 *
 * `toLand` is texture px from the nearest land (terrain.js), `perScreen` texture
 * px per screen px, `perWorld` texture px per world unit, (minX, minY) the
 * world position of the texture's corner. Returns
 * { mid, lines: [{ closed, n, data }] } with `data` a Float32Array of
 * [x, y, nx, ny, out, in] per point, all in world units: the point on the
 * contour, its normal pointing away from the land, and how far it may be pushed
 * outward / inward before it meets other land.
 */
export function coastLines(toLand, width, height, { perScreen, perWorld, minX, minY, scale }) {
  const level = SURF.mid * perScreen;
  const out = [];
  trace(toLand, width, height, level).forEach((chain) => {
    if (chain.pts.length < 4) return;
    const { xs, ys, closed, length } = resample(chain, SURF.step * perScreen, 6);
    // Under ~30 screen px round it is a speck: the lines would only be a dot.
    if (length < 30 * perScreen) return;
    const m = xs.length;
    const data = new Float32Array(m * 6);
    let before = null;
    for (let k = 0; k < m; k += 1) {
      const p = closed ? (k + m - 1) % m : Math.max(0, k - 1);
      const q = closed ? (k + 1) % m : Math.min(m - 1, k + 1);
      let nx = ys[q] - ys[p];
      let ny = xs[p] - xs[q];
      const size = Math.hypot(nx, ny) || 1;
      nx /= size;
      ny /= size;
      // Away from the land: the side where the distance grows.
      const probe = 2 * perScreen;
      const here = sample(toLand, width, height, xs[k] + nx * probe, ys[k] + ny * probe);
      const there = sample(toLand, width, height, xs[k] - nx * probe, ys[k] - ny * probe);
      if (before ? nx * before[0] + ny * before[1] < 0 : here < there) {
        nx = -nx;
        ny = -ny;
      }
      before = [nx, ny];
      // How far each way the line may be pushed while the distance keeps
      // growing one-for-one - when it stops doing so, other land is near.
      const reach = (sign, limit) => {
        let ok = 0;
        for (let o = 1; o <= limit; o += 1) {
          const v = sample(toLand, width, height, xs[k] + nx * sign * o * perScreen, ys[k] + ny * sign * o * perScreen);
          if (!(Math.abs(v - (level + sign * o * perScreen)) <= (1.5 + 0.18 * o) * perScreen)) break;
          ok = o;
        }
        return ok;
      };
      const at = k * 6;
      data[at] = minX + (xs[k] + 0.5) / perWorld;
      data[at + 1] = minY + (ys[k] + 0.5) / perWorld;
      data[at + 2] = nx;
      data[at + 3] = ny;
      data[at + 4] = reach(1, SURF.reachOut) / scale;
      data[at + 5] = reach(-1, SURF.reachIn) / scale;
    }
    out.push({ closed, n: m, data });
  });
  return out.length ? { mid: SURF.mid, lines: out } : null;
}

// ---------------------------------------------------------------- drawing

/**
 * Strokes the surf. `view` is { scale, toScreen, width, height }; `time` seconds
 * or null to hold still; `dim` 0..1 scales the strength (night). Returns the
 * number of points visited (0 = nothing drawn). `surf` gets a `shownAt` stamp
 * the first time, so a freshly built coast fades in rather than popping.
 */
export function drawSurf(ctx, surf, view, time, dim = 1) {
  if (!surf || !surf.lines) return 0;
  const { scale, toScreen, width, height } = view;
  const show = surfShow(scale, width, height) * dim;
  if (!(show > 0.01)) return 0;
  if (surf.shownAt === undefined) surf.shownAt = time === null ? -1e9 : time;
  const born = time === null ? 1 : smooth01(0, 0.9, time - surf.shownAt);
  const strength = show * born;
  if (!(strength > 0.01)) return 0;
  const origin = toScreen(0, 0);
  const u = surfPhase(time);
  const sway = time === null ? 0 : time * 0.5;
  const margin = 24;
  let visited = 0;
  ctx.save();
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let j = 0; j < SURF.lines + 1; j += 1) {
    const line = surfLine(j, u);
    if (line.alpha <= 0.01) continue;
    const push = line.dist - surf.mid;       // screen px from the traced contour
    ctx.globalAlpha = Math.min(1, line.alpha * strength);
    ctx.lineWidth = line.width;
    ctx.beginPath();
    surf.lines.forEach(({ closed, n, data }) => {
      let pen = false;
      const last = closed ? n + 1 : n;
      for (let k = 0; k < last; k += 1) {
        const at = (k % n) * 6;
        const x = data[at];
        const y = data[at + 1];
        const sx = origin.x + x * scale;
        const sy = origin.y + y * scale;
        visited += 1;
        const ripple = SURF.wobble * Math.sin((x * 0.7 + y * 0.5) * 0.8 + sway);
        const o = push + ripple;                  // screen px, signed
        const inRange = o >= 0 ? o / scale <= data[at + 4] : -o / scale <= data[at + 5];
        if (!inRange || sx < -margin || sx > width + margin || sy < -margin || sy > height + margin) {
          pen = false;
          continue;
        }
        const px = sx + data[at + 2] * o;
        const py = sy + data[at + 3] * o;
        if (pen) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
        pen = true;
      }
    });
    ctx.stroke();
  }
  ctx.restore();
  return visited;
}
