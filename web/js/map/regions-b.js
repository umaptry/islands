// Map B: the 16 regions of the one big island. Their borders (white dotted lines laid over the trees),
// their names (shown from far out, in the label space the island names use), and the flag of はじまりの村.
//
// Nothing here imports island-b.js: index.js hands in the island's questions (`regionAt`, `coastAt`)
// so the choices can be tested on their own (tests/frontend/regions-b.test.mjs).

/** World units between raster cells when the borders are looked for. */
export const BORDER_CELL = 5;
/** A border is not drawn this close to the shore (world units): the dots would sit in the surf. */
export const BORDER_SHORE = 7.5;
/** Screen px between two border dots (one dot per screen cell of this size). */
export const BORDER_GAP = 7;
export const NO_REGION = 255;

/** The midpoints between neighbouring raster cells whose regions differ, both on land and out of the
 * surf. `extent` is { minX, minY, maxX, maxY }; `regionAt(x, y)` is 0..15, or 255 off the land.
 * Returns [[x, y], ...] in world units. Made once per island, not per frame. */
export function borderPoints(extent, regionAt, coastAt, cell = BORDER_CELL) {
  const out = [];
  const cols = Math.ceil((extent.maxX - extent.minX) / cell);
  const rows = Math.ceil((extent.maxY - extent.minY) / cell);
  const grid = new Uint8Array((cols + 1) * (rows + 1));
  for (let j = 0; j <= rows; j += 1) {
    for (let i = 0; i <= cols; i += 1) {
      grid[j * (cols + 1) + i] = regionAt(extent.minX + (i + 0.5) * cell, extent.minY + (j + 0.5) * cell);
    }
  }
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const here = grid[j * (cols + 1) + i];
      if (here === NO_REGION) continue;
      const x = extent.minX + (i + 0.5) * cell;
      const y = extent.minY + (j + 0.5) * cell;
      if (coastAt(x, y) <= BORDER_SHORE) continue;
      const right = grid[j * (cols + 1) + i + 1];
      const below = grid[(j + 1) * (cols + 1) + i];
      if (right !== NO_REGION && right !== here) out.push([x + cell / 2, y]);
      if (below !== NO_REGION && below !== here) out.push([x, y + cell / 2]);
    }
  }
  return out;
}

/** The border points that show on a screen of `width` x `height`, one per `gap` px cell, as screen
 * points [[px, py], ...]. `top` keeps dots out from under the header bar. */
export function thinBorders(points, toScreen, { width, height, top = 0, gap = BORDER_GAP }) {
  const taken = new Set();
  const out = [];
  points.forEach(([x, y]) => {
    const p = toScreen(x, y);
    if (p.x < -5 || p.x > width + 5 || p.y < top || p.y > height + 5) return;
    const key = `${Math.round(p.x / gap)}|${Math.round(p.y / gap)}`;
    if (taken.has(key)) return;
    taken.add(key);
    out.push([p.x, p.y]);
  });
  return out;
}

/** White dots with a faint shadow, over the trees. `dots` from thinBorders. */
export function drawBorders(ctx, dots) {
  if (!dots.length) return;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.shadowColor = 'rgba(20,50,25,0.5)';
  ctx.shadowBlur = 2;
  ctx.beginPath();
  dots.forEach(([x, y]) => {
    ctx.moveTo(x + 1.5, y);
    ctx.arc(x, y, 1.5, 0, Math.PI * 2);
  });
  ctx.fill();
  ctx.restore();
}

/** The event's flag: a pole and a pennant, drawn flat, its foot at (x, y), `s` times its natural size. */
export function drawFlag(ctx, x, y, s = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.fillStyle = 'rgba(14,48,26,0.25)';
  ctx.beginPath();
  ctx.ellipse(3, 1, 5, 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#6b4a2e';
  ctx.fillRect(-0.8, -22, 1.6, 22);
  ctx.fillStyle = '#ff8a1f';
  ctx.beginPath();
  ctx.moveTo(0.8, -22);
  ctx.lineTo(14, -17.5);
  ctx.lineTo(0.8, -13);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** The flag's size by the zoom (the prototype's clamp(ppu / 2.6, 0.75, 1.6), ppu being px per prototype
 * unit = px per world unit x 2.5). */
export const flagSize = (scale) => Math.max(0.75, Math.min(1.6, (scale * 2.5) / 2.6));

/** The names to show, most important first: はじまりの村, then the regions, then the villages (the
 * big ones first). Each is { text, x, y, w, h, kind } on the screen, `claim` the label space
 * (decor.js makeLabelSpace: claim(x, y, w, h) is true when the room was free and is then taken).
 * Returns the ones that fit. Region names only when `far` is true. */
export function placeNames({ start = null, regions = [], villages = [], far, claim, measure }) {
  const entries = [];
  if (start) entries.push({ ...start, kind: 'start' });
  if (far) regions.forEach((region) => entries.push({ ...region, kind: 'region' }));
  [...villages].sort((a, b) => (b.weight || 0) - (a.weight || 0)).forEach((v) => entries.push({ ...v, kind: 'village' }));
  const placed = [];
  entries.forEach((entry) => {
    const w = entry.w ?? measure(entry);
    const h = entry.h ?? 15;
    if (claim(entry.x, entry.y, w, h)) placed.push({ ...entry, w, h });
  });
  return placed;
}

/** The text of a region's name on the map. */
export const regionText = (region) => `${region.name} 地方`;

/** The world box the whole-map camera frames and the sea decoration stays in: the island's outer box
 * { minX, minY, maxX, maxY } with a little room round it, as [minX, minY, maxX, maxY]. */
export const FRAME_MIN = 40;   // world units: a shoal the coast's wobble pushes out must not be cut off

export function frameOf(extent, share = 0.03) {
  const padX = Math.max(FRAME_MIN, (extent.maxX - extent.minX) * share);
  const padY = Math.max(FRAME_MIN, (extent.maxY - extent.minY) * share);
  return [extent.minX - padX, extent.minY - padY, extent.maxX + padX, extent.maxY + padY];
}

/** Faces that would cover each other, nearer in than this many screen px on both axes, are thinned. */
export const FACE_CROWD = 20;

/** Close in, a face that lands within `limit` px (each axis) of one already kept is left out (its house
 * stays). Ask in priority order: `crowded(x, y)` says whether the face would cover a kept one, and
 * `keep(x, y)` records a face that is drawn. */
export function makeFaceCrowd(limit = FACE_CROWD) {
  const bins = new Map();
  const key = (gx, gy) => `${gx},${gy}`;
  return {
    crowded(x, y) {
      const gx = Math.floor(x / limit);
      const gy = Math.floor(y / limit);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const list = bins.get(key(gx + dx, gy + dy));
          if (list && list.some(([px, py]) => Math.abs(px - x) < limit && Math.abs(py - y) < limit)) return true;
        }
      }
      return false;
    },
    keep(x, y) {
      const k = key(Math.floor(x / limit), Math.floor(y / limit));
      if (!bins.has(k)) bins.set(k, []);
      bins.get(k).push([x, y]);
    },
  };
}
