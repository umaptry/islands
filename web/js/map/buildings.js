// The map's buildings, drawn in code: settlements that grow from a hut to a
// city, landmarks, trees and rocks, all seen from above at an angle (design 05
// リアル・レリーフ, palette 03 クリア・スカイ). Light comes from the top-left and
// shadows fall softly to the bottom-right, the same way as the ground's relief.
//
// Nothing is loaded: every shape is painted with canvas paths the first time it
// is wanted, into a small off-screen canvas that is then stamped with drawImage.
// A frame with hundreds of trees therefore costs hundreds of drawImage calls,
// not hundreds of painted shapes.
//
// Shapes are written in "design units" (a house is ~9 wide). A scene is run
// twice on a cache miss: once with no canvas just to learn its bounds, once for
// real. The bounds give the off-screen canvas its size and the returned box.

import { PALETTE, mixHex } from './palette.js';
import { landmarkLights, landmarkMesh, landmarkSize } from './landmarks.js';
import { HOUSE_TIERS, SHADOW_OF, facesOf, houseLights, houseTurn, partsOf, shadowOutline, tierIndex } from './mesh.js';

export const TIER_COUNT = 5;

// ---------------------------------------------------------------- colours
const INK = '#1B2430';
const dark = (c, t) => mixHex(c, INK, t);
const light = (c, t) => mixHex(c, '#FFFFFF', t);

const SAND_SHADE = dark(PALETTE.sand, 0.25);
// Wall faces: top is lit, left is the lit side, right is in shade.
const WALL = [PALETTE.wall, mixHex(PALETTE.wall, SAND_SHADE, 0.35), mixHex(PALETTE.wall, SAND_SHADE, 0.6)];
const GLASS = mixHex(PALETTE.shallow, '#FFFFFF', 0.35);
const WARM = '#FFD98A';
const LEAF = dark(PALETTE.forest, 0.12);
const WOOD = '#D9BE92';
const ROOFS = [PALETTE.roof, light(PALETTE.roof, 0.22), mixHex(PALETTE.roof, '#F2A65A', 0.4)];

/** A quiet island: about CSS saturate(55%) brightness(103%), done on the colour. */
const calmCache = new Map();
function calmColor(hex) {
  let out = calmCache.get(hex);
  if (out) return out;
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const f = (c) => Math.max(0, Math.min(255, Math.round((lum + (c - lum) * 0.55) * 1.03)));
  out = `#${[f(r), f(g), f(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  calmCache.set(hex, out);
  return out;
}

// ---------------------------------------------------------------- the pen
/** A canvas context that also keeps track of what it drew (bounds, lights).
 * With ctx = null it only measures. `vis` is what the eye sees (the returned
 * box); `all` also holds the soft shadows (the off-screen canvas size). */
function makePen(ctx, { calm, night, px, soft = 1, hair = 0 }) {
  const empty = () => ({ l: Infinity, t: Infinity, r: -Infinity, b: -Infinity });
  const vis = empty();
  const all = empty();
  const lights = [];
  let shadowMode = false;
  let anchor = null;
  const tint = calm ? calmColor : (c) => c;

  const seen = (x, y, pad = 0) => {
    for (const bd of shadowMode ? [all] : [all, vis]) {
      bd.l = Math.min(bd.l, x - pad); bd.r = Math.max(bd.r, x + pad);
      bd.t = Math.min(bd.t, y - pad); bd.b = Math.max(bd.b, y + pad);
    }
  };
  const path = (pts) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  };

  const pen = {
    night, vis, all, lights,
    /** Where the foot of the thing is (y), when that is not the lowest point. */
    foot(y) { anchor = y; },
    get anchor() { return anchor; },
    /** One face of a solid shape: filled and edged in the same colour, so no
     * hairline of the ground shows between two faces. */
    facet(pts, fill) {
      pts.forEach(([x, y]) => seen(x, y));
      if (!ctx) return;
      const c = tint(fill);
      ctx.fillStyle = c;
      ctx.strokeStyle = c;
      ctx.lineJoin = 'round';
      ctx.lineWidth = hair;
      path(pts);
      ctx.fill();
      ctx.stroke();
    },
    poly(pts, fill, alpha = 1) {
      pts.forEach(([x, y]) => seen(x, y));
      if (!ctx) return;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = tint(fill);
      path(pts);
      ctx.fill();
      ctx.globalAlpha = 1;
    },
    circ(cx, cy, r, fill, alpha = 1) { pen.ell(cx, cy, r, r, fill, alpha); },
    ell(cx, cy, rx, ry, fill, alpha = 1) {
      seen(cx - rx, cy - ry); seen(cx + rx, cy + ry);
      if (!ctx) return;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = tint(fill);
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    },
    /** The upper half of an ellipse (a dome) standing on y = cy. */
    dome(cx, cy, rx, ry, fill) {
      seen(cx - rx, cy - ry); seen(cx + rx, cy);
      if (!ctx) return;
      ctx.fillStyle = tint(fill);
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, Math.PI, Math.PI * 2);
      ctx.closePath();
      ctx.fill();
    },
    ring(cx, cy, rx, ry, color, width) {
      seen(cx - rx, cy - ry, width / 2); seen(cx + rx, cy + ry, width / 2);
      if (!ctx) return;
      ctx.strokeStyle = tint(color);
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    },
    line(x1, y1, x2, y2, color, width, dash = null, alpha = 1) {
      seen(x1, y1, width / 2); seen(x2, y2, width / 2);
      if (!ctx) return;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = tint(color);
      ctx.lineWidth = width;
      ctx.lineCap = 'butt';
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      if (dash) ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    },
    /** A soft shadow: not part of the box, but part of the canvas. */
    shadow(pts) {
      shadowMode = true;
      pts.forEach(([x, y]) => seen(x, y, 2));
      shadowMode = false;
      if (!ctx) return;
      // `soft` grows with the picture: a big building gets a wider, lighter
      // shadow instead of the same hard edge scaled up (1 = the small look).
      ctx.globalAlpha = 0.26 / soft ** 0.3;
      ctx.fillStyle = dark(PALETTE.forest, 0.75);
      if ('filter' in ctx) ctx.filter = `blur(${(0.9 * px * soft).toFixed(2)}px)`;
      path(pts);
      ctx.fill();
      if ('filter' in ctx) ctx.filter = 'none';
      ctx.globalAlpha = 1;
    },
    shadowEll(cx, cy, rx, ry) {
      pen.shadow(Array.from({ length: 14 }, (_, i) => {
        const t = (i / 14) * Math.PI * 2;
        return [cx + Math.cos(t) * rx, cy + Math.sin(t) * ry];
      }));
    },
    /** A pool of warm light for the night layer (design units). */
    light(x, y, r, a = 0.5, color = WARM) { if (night) lights.push({ x, y, r, a, color }); },
  };
  return pen;
}

// ---------------------------------------------------------------- shapes
const faces = (w) => [w * 0.55, w * 0.3];

/** The shadow a box of this footprint and height throws to the bottom-right. */
function shadowOf(p, cx, cy, w, h) {
  const [a, b] = faces(w);
  const sx = h * 0.55 + 1;
  const sy = h * 0.28 + 0.5;
  p.shadow([[cx - a, cy], [cx, cy + b], [cx + sx, cy + b + sy], [cx + a + sx, cy + sy], [cx + sx, cy - b + sy], [cx, cy - b]]);
}

/** A box seen from above: top, left face (lit), right face (shaded). (cx, cy)
 * is the middle of its base; windows = a colour draws rows of them. */
function box(p, cx, cy, w, h, top, left, right, windows = null) {
  const [a, b] = faces(w);
  p.poly([[cx - a, cy - h], [cx, cy - h + b], [cx, cy + b], [cx - a, cy]], left);
  p.poly([[cx + a, cy - h], [cx, cy - h + b], [cx, cy + b], [cx + a, cy]], right);
  p.poly([[cx, cy - h - b], [cx + a, cy - h], [cx, cy - h + b], [cx - a, cy - h]], top);
  if (windows) {
    const col = p.night ? WARM : windows;
    const al = p.night ? 1 : 0.8;
    let row = 0;
    for (let z = 3.2; z < h - 2; z += 3.6, row += 1) {
      const dash = [1.5, 1.1];
      p.line(cx - a * 0.84, cy - z + b * 0.16, cx - a * 0.16, cy - z + b * 0.84, col, 1.2, dash, al);
      p.line(cx + a * 0.16, cy - z + b * 0.84, cx + a * 0.84, cy - z + b * 0.16, col, 1.2, dash, al * 0.9);
      if (p.night && row % 2 === 0) p.light(cx + a * 0.5, cy - z + b * 0.5, 4.5, 0.2);
    }
  }
}

/** A pyramid roof on a box top. */
function roof(p, cx, cy, w, h, rh, color) {
  const [a, b] = faces(w);
  const ap = [cx, cy - h - rh];
  const L = [cx - a, cy - h];
  const F = [cx, cy - h + b];
  const R = [cx + a, cy - h];
  const B = [cx, cy - h - b];
  p.poly([L, B, ap], light(color, 0.22));
  p.poly([B, R, ap], color);
  p.poly([L, F, ap], light(color, 0.08));
  p.poly([F, R, ap], dark(color, 0.2));
}

/** A gable roof; the ridge runs from the back-left to the front-right. */
function gable(p, cx, cy, w, h, rh, color, endColor = WALL[2]) {
  const [a, b] = faces(w);
  const L = [cx - a, cy - h];
  const F = [cx, cy - h + b];
  const R = [cx + a, cy - h];
  const B = [cx, cy - h - b];
  const M1 = [cx - a / 2, cy - h - b / 2 - rh];
  const M2 = [cx + a / 2, cy - h + b / 2 - rh];
  p.poly([B, R, M2, M1], dark(color, 0.1));
  p.poly([L, F, M2, M1], light(color, 0.14));
  p.poly([F, R, M2], endColor);
  p.line(M1[0], M1[1], M2[0], M2[1], light(color, 0.35), 0.6);
}

/** A door and a window on the shaded face. */
function openings(p, cx, cy, w, h, door = true) {
  const [a, b] = faces(w);
  const faceY = (x) => cy + b * (1 - (x - cx) / a);
  if (door) {
    const x1 = cx + a * 0.3;
    const x2 = cx + a * 0.52;
    p.poly([[x1, faceY(x1)], [x2, faceY(x2)], [x2, faceY(x2) - 2.6], [x1, faceY(x1) - 2.6]], dark(PALETTE.roof, 0.35));
  }
  const wx = cx + a * 0.72;
  const wy = faceY(wx) - h * 0.55;
  p.poly([[wx - 0.8, wy - 0.9], [wx + 0.8, wy - 1.2], [wx + 0.8, wy + 0.6], [wx - 0.8, wy + 0.9]], p.night ? WARM : GLASS);
  p.light(wx, wy, 4, 0.4);
}

/** A house: a box with a pyramid or gable roof. */
function house(p, cx, cy, w, h, { style = 'pyr', roofColor = PALETTE.roof, windows = false } = {}) {
  box(p, cx, cy, w, h, WALL[0], WALL[1], WALL[2], windows ? GLASS : null);
  if (style === 'gable') gable(p, cx, cy, w, h, w * 0.36, roofColor);
  else roof(p, cx, cy, w, h, w * 0.42, roofColor);
  if (!windows) openings(p, cx, cy, w, h, w >= 7.5);
}

/** A round-crowned tree. r = crown radius; tone 0..2 varies the green a little. */
function tree(p, cx, cy, r, tone = 0) {
  const leaf = mixHex(LEAF, tone === 1 ? PALETTE.grass : tone === 2 ? INK : LEAF, tone ? 0.18 : 0);
  p.circ(cx, cy - r, r, leaf);
  p.circ(cx - r * 0.32, cy - r * 1.35, r * 0.55, light(PALETTE.forest, 0.25), 0.8);
  p.circ(cx + r * 0.35, cy - r * 0.55, r * 0.5, dark(leaf, 0.14), 0.45);
}
const treeShadow = (p, cx, cy, r) => p.shadowEll(cx + r * 0.7, cy + r * 0.2, r * 1.1, r * 0.55);

/** Seeded random numbers (mulberry32): the same island always gets the same layout. */
function rng(seed) {
  let s = (seed | 0) + 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- settlements
/** Collect items of a cluster, then paint all shadows first and bodies from the back. */
function makeCluster(seed, tier) {
  const rand = rng(seed * 7919 + tier * 104729 + 17);
  const flip = (seed & 1) === 1 ? -1 : 1;
  const items = [];
  // Bigger clusters sit closer together, so a small stamp still shows its houses.
  const S = [1, 0.8, 0.8, 0.74, 0.7][tier];
  const jit = () => (rand() - 0.5) * 2.2;
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const api = {
    house(x, y, w, h, o = {}) {
      const cx = flip * x * S + jit() * 0.6;
      const cy = y * S + jit() * 0.5;
      const opts = { style: rand() < 0.45 ? 'gable' : 'pyr', roofColor: rand() < 0.28 ? pick(ROOFS.slice(1)) : ROOFS[0], ...o };
      items.push({ y: cy, sh: (p) => shadowOf(p, cx, cy, w, h + w * 0.3), body: (p) => house(p, cx, cy, w, h, opts) });
    },
    tower(x, yy, w, h, top = 'flat') {
      const cx = flip * x * S;
      const y = yy * S;
      const bluish = rand() < 0.5;
      items.push({
        y,
        sh: (p) => shadowOf(p, cx, y, w, h),
        body: (p) => {
          const t = bluish ? mixHex(WALL[0], PALETTE.shallow, 0.18) : WALL[0];
          const l = bluish ? mixHex(WALL[1], PALETTE.shallow, 0.3) : WALL[1];
          const r = bluish ? mixHex(WALL[2], PALETTE.shallow, 0.3) : WALL[2];
          box(p, cx, y, w, h, t, l, r, GLASS);
          if (top === 'step') {
            box(p, cx, y - h, w * 0.6, 3.2, WALL[0], WALL[1], WALL[2], GLASS);
            roof(p, cx, y - h, w * 0.6, 3.2, 3, PALETTE.roof);
          } else if (top === 'spire') {
            box(p, cx, y - h, w * 0.5, 2.4, WALL[0], WALL[1], WALL[2]);
            roof(p, cx, y - h, w * 0.5, 2.4, w * 1.0, PALETTE.roof);
          } else {
            box(p, cx + w * 0.12, y - h, w * 0.34, 1.8, light(WALL[0], 0.0), WALL[1], WALL[2]);
          }
        },
      });
    },
    tree(x, yy, r) {
      const cx = flip * x * S;
      const y = yy * S;
      const tone = Math.floor(rand() * 3);
      items.push({ y, sh: (p) => treeShadow(p, cx, y, r), body: (p) => tree(p, cx, y, r, tone) });
    },
    /** Anything drawn as it is: a pier, a boat. */
    thing(y, body, sh = null) { items.push({ y, sh, body }); },
    flip,
    paint(p) {
      items.sort((a, b) => a.y - b.y);
      items.forEach((it) => it.sh && it.sh(p));
      items.forEach((it) => it.body(p));
    },
  };
  return api;
}

/** A short pier with a boat at its end (港町). dir: +1 pier points right-down. */
function pierAndBoat(p, x0, y0, flip) {
  const dx = flip * 1;
  const len = 15;
  const wd = 3.6;
  const ex = x0 + dx * len;
  const ey = y0 + len * 0.54;
  const nx = dx * 0.5 * wd * 0.9;
  const ny = -0.5 * wd * 0.5;
  // deck side (thickness) first, then the planks
  p.poly([[x0 - nx, y0 - ny + 1.3], [ex - nx, ey - ny + 1.3], [ex + nx, ey + ny + 1.3], [x0 + nx, y0 + ny + 1.3]], dark(WOOD, 0.4));
  p.poly([[x0 - nx, y0 - ny], [ex - nx, ey - ny], [ex + nx, ey + ny], [x0 + nx, y0 + ny]], WOOD);
  for (let i = 1; i < 7; i += 1) {
    const t = i / 7;
    p.line(x0 + dx * len * t - nx, y0 + len * 0.54 * t - ny, x0 + dx * len * t + nx, y0 + len * 0.54 * t + ny, dark(WOOD, 0.22), 0.5);
  }
  [0.35, 1].forEach((t) => {
    const px = x0 + dx * len * t + nx;
    const py = y0 + len * 0.54 * t + ny;
    p.line(px, py + 1.2, px, py + 4, dark(WOOD, 0.5), 1);
  });
  // the boat
  const bx = ex + dx * 3.4;
  const by = ey + 3.2;
  p.shadowEll(bx + 1.5, by + 1.2, 5, 1.7);
  p.poly([[bx - 4.6, by - 1.4], [bx + 4.6, by - 0.4], [bx + 3.2, by + 1.6], [bx - 3.2, by + 1.2]], '#FFFFFF');
  p.poly([[bx - 4.6, by - 1.4], [bx + 4.6, by - 0.4], [bx + 4.4, by + 0.1], [bx - 4.5, by - 0.9]], PALETTE.roof);
  p.line(bx, by - 1, bx, by - 7, WOOD, 0.6);
  p.poly([[bx + 0.3, by - 6.8], [bx + 0.3, by - 1.8], [bx + 3.6, by - 1.8]], '#FFFFFF');
  p.poly([[bx - 0.3, by - 5.8], [bx - 0.3, by - 1.8], [bx - 2.6, by - 1.8]], light(PALETTE.shallow, 0.5));
}

/** The scene of a settlement tier (0..4), centred on x = 0. */
function settlementScene(p, tier, seed) {
  const c = makeCluster(seed, tier);
  if (tier === 0) {
    c.house(-2, 0, 9, 6.5);
    c.tree(10, 4, 3.4);
  } else if (tier === 1) {
    [[-9, 2, 9, 6.5], [5, -4, 9, 7], [11, 6, 8, 6]].forEach((h) => c.house(...h));
    [[-18, -1, 3], [20, 1, 2.8], [-2, 10, 2.6]].forEach((t) => c.tree(...t));
  } else if (tier === 2) {
    [[-14, 1, 9, 6.5], [-2, -6, 9, 7], [10, -3, 9, 6.5], [-7, 8, 8, 6], [4, 7, 8, 5.5]].forEach((h) => c.house(...h));
    [[-23, -2, 2.8], [21, -9, 2.6]].forEach((t) => c.tree(...t));
    c.thing(12, (pp) => pierAndBoat(pp, 12 * c.flip, 10, c.flip));
  } else if (tier === 3) {
    [[-12, -9, 9, 9, { windows: true, style: 'gable' }], [1, -11, 10, 14, { windows: true }], [13, -8, 9, 8, { style: 'gable' }],
      [-21, 0, 8, 6], [-8, -1, 9, 11, { windows: true, style: 'gable' }], [9, 1, 9, 7],
      [-14, 9, 8, 5.5], [1, 10, 9, 6.5], [15, 9, 8, 5.5]].forEach(([x, y, w, h, o]) => c.house(x, y, w, h, o));
    [[-29, 4, 3], [26, 3, 2.8], [-24, 15, 2.6], [24, 16, 2.6]].forEach((t) => c.tree(...t));
  } else {
    [[-16, -6, 9, 22, 'step'], [0, -10, 10, 31, 'spire'], [16, -5, 9, 25, 'flat']].forEach((t) => c.tower(...t));
    [[-26, 4, 8, 12, 'flat'], [-9, 5, 9, 17, 'step'], [9, 6, 9, 20, 'flat'], [26, 5, 8, 13, 'step']].forEach((t) => c.tower(...t));
    [[-19, 15, 8, 6, { style: 'gable' }], [-4, 17, 9, 7, { windows: true }], [11, 17, 8, 6], [24, 15, 8, 5.5, { style: 'gable' }]]
      .forEach(([x, y, w, h, o]) => c.house(x, y, w, h, o));
    [[-34, 11, 2.8], [34, 12, 2.6], [3, 26, 2.4], [-14, 26, 2.4], [18, 26, 2.4]].forEach((t) => c.tree(...t));
  }
  c.paint(p);
}

// ---------------------------------------------------------------- landmarks
const LANDMARKS = new Map([
  ['灯台', ['lighthouse', 'lighthouse']],
  ['時計塔', ['tower', 'clock']], ['見張り台', ['tower', 'watch']],
  ['天文台', ['dome', 'observatory']], ['音楽堂', ['dome', 'music']],
  ['図書館', ['manor', 'library']], ['学び舎', ['manor', 'school']], ['画廊', ['manor', 'gallery']], ['劇場', ['manor', 'theater']],
  ['工房', ['workshop', 'workshop']], ['鍛冶場', ['workshop', 'smithy']],
  ['研究所', ['clinic', 'lab']], ['診療所', ['clinic', 'clinic']],
  ['温室', ['greenhouse', 'greenhouse']],
  ['風車', ['windmill', 'windmill']],
  ['市場', ['market', 'market']],
  ['港の桟橋', ['pier', 'pier']], ['釣り小屋', ['pier', 'fishhut']],
  ['広場', ['flat', 'plaza']], ['畑', ['flat', 'farm']], ['運動場', ['flat', 'field']], ['庭園', ['flat', 'garden']],
  ['茶屋', ['shop', 'teahouse']], ['パン屋', ['shop', 'bakery']],
]);

export const LANDMARK_NAMES = [...LANDMARKS.keys()];

/** Which shape a landmark name is drawn with: { type, variant }. A name that is
 * not known becomes a manor (a gabled hall). */
export function landmarkForm(name) {
  const hit = LANDMARKS.get(name);
  return hit ? { type: hit[0], variant: hit[1] } : { type: 'manor', variant: 'default' };
}

/** A landmark: its solid faces, then the lights it keeps for the night. */
function landmarkScene(p, name) {
  const { type, variant } = landmarkForm(name);
  solidFaces(p, landmarkMesh(type, variant));
  landmarkLights(type, variant).forEach((l) => p.light(l.x, l.y, l.r, l.a, l.color));
}

function landmarkShadowScene(p, name) {
  const { type, variant } = landmarkForm(name);
  const { h, rr } = landmarkSize(type, variant);
  p.shadow(shadowOutline(rr, h));
}

// ---------------------------------------------------------------- tree sprites
// Trees, rocks and houses are small solids (mesh.js): their faces are laid down
// with the pen, in world units, and the sprite is scaled so that TREE_UNITS
// (or HOUSE_UNITS) design units are `size` px wide. The foot of the picture is
// the point on the ground the thing stands on.
const TREE_KINDS = ['tree', 'pine', 'bush', 'rock'];
const TREE_UNITS = 2.2;    // a round tree or a pine is this wide, in world units, at size 1
const HOUSE_UNITS = 3;     // `size` of a house is this many world units, in px
const LANDMARK_UNITS = 3.8; // `size` of a landmark is this many world units, in px

/** Draw the faces of a solid, then its light (a house window at night). */
function solidFaces(p, parts) {
  p.foot(0);
  facesOf(parts).forEach((face) => p.facet(face.pts, face.fill));
}

function solidScene(p, kind, variant) {
  solidFaces(p, partsOf(kind, variant));
}

function solidShadowScene(p, kind) {
  const [rr, h] = SHADOW_OF[kind];
  p.shadow(shadowOutline(rr, h));
}

function treeScene(p, kind, seed) {
  solidScene(p, kind, kind === 'rock' ? seed : 0);
}

function treeShadowScene(p, kind) {
  solidShadowScene(p, kind);
}

function houseScene(p, seed, tier = 1) {
  solidScene(p, HOUSE_TIERS[tier], seed);
  houseLights(tier, seed).forEach(([x, y, r]) => p.light(x, y, r, 0.7));
}

// ---------------------------------------------------------------- cache
const MAX_ENTRIES = 600;
const SOFT_FROM = 40; // shadows are blurred more from this width (px) on
const cache = new Map();
const fitCache = new Map();

// Sizes are cached in steps of ~15% up to a ceiling, and a stamp is drawn at
// its real size by stretching the nearest step (at most ~7% off). Buildings now
// grow with the map, so a pinch crosses many sizes: with the old 2 px steps
// every few frames would have painted a new picture. Above the ceiling the
// ceiling's picture is enlarged (it softens, but costs nothing).
const STEP_MIN = 6;
const STEP_RATIO = 1.15;
const STEP_MAX = 160;
const STEP_COUNT = Math.round(Math.log(STEP_MAX / STEP_MIN) / Math.log(STEP_RATIO));

/** The size a picture is painted at for a stamp that is `size` px wide. */
export const stepSize = (size) => {
  const n = Math.round(Math.log(Math.max(size, STEP_MIN) / STEP_MIN) / Math.log(STEP_RATIO));
  return Math.round(STEP_MIN * STEP_RATIO ** Math.min(n, STEP_COUNT) * 10) / 10;
};

/** The device scale a ctx paints at, in quarter steps (so a smooth zoom does
 * not make a new cache entry every frame). */
function scaleOf(ctx) {
  let a = 1;
  try { a = ctx.getTransform().a; } catch { a = 1; }
  if (!(a > 0)) a = 1;
  return Math.min(4, Math.max(0.5, Math.round(a * 4) / 4));
}

/** The cache key of a stamp. */
export function cacheKey({ shape, id, size, calm = false, night = false, dpr = 1, seed = 0 }) {
  return [shape, id, stepSize(size), calm ? 1 : 0, night ? 1 : 0, dpr, seed | 0].join('|');
}

/** The box a stamp covers when its foot is at (x, foot): `rel` holds the
 * bounds relative to the foot point. */
export function placeBox(rel, x, foot) {
  return {
    left: x + rel.l, top: foot + rel.t, right: x + rel.r, bottom: foot + rel.b,
    w: rel.r - rel.l, h: rel.b - rel.t,
  };
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Paint a scene into a new entry. `fit` = how the scale is chosen: a function
 * of the measured bounds at scale 1. */
function render({ scene, shadows, size, calm, night, dpr, fitKey, fitMode, lightsOnly = false, sharp = false }) {
  const flags = { calm, night, px: dpr, soft: Math.max(1, size / SOFT_FROM) };
  // 1. measure at scale 1
  let w0 = fitCache.get(fitKey);
  if (w0 === undefined) {
    const probe = makePen(null, flags);
    scene(probe);
    if (shadows) shadows(probe);
    w0 = Math.max(1, probe.vis.r - probe.vis.l);
    fitCache.set(fitKey, w0);
    if (fitCache.size > 2000) fitCache.delete(fitCache.keys().next().value);
  }
  const k = fitMode === 'width' ? size / w0 : size / fitMode;
  // 2. measure at the real scale to size the canvas
  const probe = makePen(null, flags);
  if (shadows) shadows(probe);
  scene(probe);
  const { vis, all } = probe;
  const base = probe.anchor === null ? vis.b : probe.anchor;
  const shiftY = -base * k; // the foot of the thing sits on y = 0
  const m = 4;
  const cl = Math.floor(all.l * k - m);
  const ct = Math.floor(all.t * k + shiftY - m);
  const cap = sharp ? Infinity : 700;
  const cw = Math.min(cap, Math.ceil(all.r * k + m - cl));
  const ch = Math.min(cap, Math.ceil(all.b * k + shiftY + m - ct));
  const rel = { l: vis.l * k, r: vis.r * k, t: vis.t * k + shiftY, b: vis.b * k + shiftY };
  const scaleLights = (list) => list.map((l) => ({ ...l, x: l.x * k, y: l.y * k + shiftY, r: l.r * k }));
  // The night layer only needs where the lights are, which the measuring pass
  // already knows: no picture of the building itself.
  if (sharp && !lightsOnly && cw * ch * dpr * dpr > MAX_ONE_PX) return null; // too big to keep: the stretched one is used
  if (lightsOnly) return { canvas: null, cl, ct, cw: 0, ch: 0, dpr, rel, step: size, lights: scaleLights(probe.lights), glow: null };
  let canvas = null;
  let pen = null;
  try {
    canvas = makeCanvas(Math.max(1, Math.ceil(cw * dpr)), Math.max(1, Math.ceil(ch * dpr)));
    const cx = canvas.getContext('2d');
    if (!cx) throw new Error('no 2d context');
    cx.setTransform(dpr, 0, 0, dpr, -cl * dpr, -ct * dpr);
    cx.translate(0, shiftY);
    cx.scale(k, k);
    pen = makePen(cx, { ...flags, hair: 0.7 / (k * dpr) });
    if (shadows) shadows(pen);
    scene(pen);
  } catch {
    // Out of memory or no context: draw nothing for this one, keep the map going.
    return { canvas: null, cl, ct, cw: 0, ch: 0, dpr, rel, step: size, lights: [], glow: null };
  }
  return { canvas, cl, ct, cw, ch, dpr, rel, step: size, lights: scaleLights(pen.lights), glow: null };
}

/** Find or paint the entry for a stamp; evict the oldest when the cache is full. */
function entryFor(key, make) {
  let e = cache.get(key);
  if (e) {
    cache.delete(key);
    cache.set(key, e);
    return e;
  }
  e = make();
  cache.set(key, e);
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return e;
}

// Pictures at their real size. While the camera moves, a big stamp is the
// 160 px picture stretched (cheap, soft). Once the camera has been still for a
// moment (setSettled), a stamp wider than that is painted at its real size, so
// a close-up is crisp. Such pictures are few but large, so they live in their
// own cache with a budget in pixels (phones have little memory), and only a
// few are painted per frame so the first still frame does not stall.
const SHARP_BUDGET_PX = 24e6;   // all kept pictures together (~96 MB at 4 bytes)
const MAX_ONE_PX = 6e6;         // one picture; a bigger one stays stretched
const MAX_BUILDS_PER_FRAME = 3;
const sharpCache = new Map();
let sharpPx = 0;
let settled = false;
let builds = 0;

/** Called once per frame: is the camera still, so big stamps are painted
 * sharp? Also resets the per-frame painting allowance. */
export function setSettled(still) {
  settled = !!still;
  builds = 0;
}

function dropSharp(key) {
  const e = sharpCache.get(key);
  if (e) { sharpPx -= e.px || 0; sharpCache.delete(key); }
}

function trimSharp(keep) {
  for (const k of sharpCache.keys()) {
    if (sharpPx <= SHARP_BUDGET_PX) break;
    if (k !== keep) dropSharp(k);
  }
}

/** The real-size entry for this stamp, or null (not settled, small, too big,
 * or the frame's painting allowance is used up: use the stretched one). */
function sharpEntry(parts, size, make) {
  if (!settled || !(size > STEP_MAX)) return null;
  const s = Math.round(size * 2) / 2;
  const key = `${cacheKey({ ...parts, size: STEP_MAX })}|x${s}`;
  let e = sharpCache.get(key);
  if (e) {
    sharpCache.delete(key);
    sharpCache.set(key, e);
    return e.skip ? null : e;
  }
  if (builds >= MAX_BUILDS_PER_FRAME) return null;
  builds++;
  const made = make(s);
  e = made && made.canvas !== undefined ? made : { skip: true, px: 0 };
  // A failed paint (canvas null on a picture that should have one) is not kept.
  e.px = made && made.canvas ? made.canvas.width * made.canvas.height : 0;
  e.key = key;
  sharpCache.set(key, e);
  sharpPx += e.px;
  trimSharp(key);
  return e.skip ? null : e;
}

/** The entry to use for a stamp: real size when settled, else the nearest step. */
function pickEntry(parts, size, make) {
  return sharpEntry(parts, size, make)
    || entryFor(cacheKey({ ...parts, size }), () => make(stepSize(size)));
}

/** Stamp an entry at its real `size` (the picture is painted at e.step). */
function stamp(ctx, e, x, foot, alpha, size) {
  const f = size / e.step;
  const dx = Math.round((x + e.cl * f) * e.dpr) / e.dpr;
  const dy = Math.round((foot + e.ct * f) * e.dpr) / e.dpr;
  const prev = ctx.globalAlpha;
  if (alpha < 1) ctx.globalAlpha = prev * alpha;
  if (e.canvas) {
    // Stretched pictures need smoothing, or the outline turns into dots.
    const smooth = ctx.imageSmoothingEnabled;
    const quality = ctx.imageSmoothingQuality;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(e.canvas, dx, dy, e.cw * f, e.ch * f);
    ctx.imageSmoothingEnabled = smooth;
    ctx.imageSmoothingQuality = quality;
  }
  if (alpha < 1) ctx.globalAlpha = prev;
  return placeBox({ l: e.rel.l * f, r: e.rel.r * f, t: e.rel.t * f, b: e.rel.b * f }, x, foot);
}

// ---------------------------------------------------------------- the public drawing
/** Draw a settlement standing on (x, foot). tier 0..4 = 小屋・村・港町・町・都市.
 * `size` is the width in CSS px. Returns the box it covered. */
export function drawSettlement(ctx, tier, x, foot, size, opts = {}) {
  if (!ctx || !(size > 0)) return null;
  const { alpha = 1, calm = false, night = false, seed = 0 } = opts;
  const t = Math.max(0, Math.min(TIER_COUNT - 1, Math.round(tier) || 0));
  const dpr = scaleOf(ctx);
  const e = pickEntry({ shape: 'settlement', id: t, calm, night, dpr, seed }, size, (s) => render({
    scene: (p) => settlementScene(p, t, seed | 0),
    size: s, calm, night, dpr, fitMode: 'width', fitKey: `s|${t}|${seed | 0}|${night ? 1 : 0}`, sharp: s > STEP_MAX,
  }));
  return stamp(ctx, e, x, foot, alpha, size);
}

/** Draw a landmark standing on (x, foot); `size` is the width of its footprint
 * in CSS px (a tall tower is taller than that). */
export function drawLandmark(ctx, name, x, foot, size, opts = {}) {
  if (!ctx || !(size > 0)) return null;
  const { alpha = 1, calm = false, night = false } = opts;
  const dpr = scaleOf(ctx);
  const id = LANDMARKS.has(name) ? name : 'default';
  const e = pickEntry({ shape: 'landmark', id, calm, night, dpr, seed: 0 }, size, (s) => render({
    scene: (p) => landmarkScene(p, name),
    shadows: (p) => landmarkShadowScene(p, name),
    size: s, calm, night, dpr, fitMode: LANDMARK_UNITS, fitKey: `l|${id}`, sharp: s > STEP_MAX,
  }));
  return stamp(ctx, e, x, foot, alpha, size);
}

/** Draw a tree, pine, bush or rock standing on (x, foot); `size` is the width
 * of a tree of size 1 in px (a rock or bush is smaller by its own shape). */
export function drawTree(ctx, kind, x, foot, size, opts = {}) {
  if (!ctx || !(size > 0)) return null;
  const { alpha = 1, calm = false, seed = 0 } = opts;
  const k = TREE_KINDS.includes(kind) ? kind : 'tree';
  const dpr = scaleOf(ctx);
  const tone = k === 'rock' ? Math.abs(seed | 0) % 3 : 0;
  const e = pickEntry({ shape: 'tree', id: k, calm, night: false, dpr, seed: tone }, size, (s) => render({
    scene: (p) => treeScene(p, k, tone),
    shadows: (p) => treeShadowScene(p, k),
    size: s, calm, night: false, dpr, fitMode: TREE_UNITS, fitKey: `t|${k}`, sharp: s > STEP_MAX,
  }));
  return stamp(ctx, e, x, foot, alpha, size);
}

/** Draw a house standing on (x, foot). `size` is the length of 3 world units in
 * px; `seed` turns it (15 degrees a step, six turns); `tier` is 0..3 or its name
 * (hut, house, manor, castle; a house when left out). */
export function drawHouse(ctx, x, foot, size, opts = {}) {
  if (!ctx || !(size > 0)) return null;
  const { alpha = 1, calm = false, seed = 0 } = opts;
  const dpr = scaleOf(ctx);
  const turn = houseTurn(seed);
  const tier = tierIndex(opts.tier);
  const kind = HOUSE_TIERS[tier];
  const e = pickEntry({ shape: 'house', id: kind, calm, night: false, dpr, seed: turn }, size, (s) => render({
    scene: (p) => houseScene(p, turn, tier),
    shadows: (p) => solidShadowScene(p, kind),
    size: s, calm, night: false, dpr, fitMode: HOUSE_UNITS, fitKey: `h|${kind}`, sharp: s > STEP_MAX,
  }));
  return stamp(ctx, e, x, foot, alpha, size);
}

/** The night's lights only: call after the dark colour has been laid over the
 * map. what = { tier } or { landmark: name } or { house: true, seed, tier: 0..3 }; pass the same `seed` / `calm` the
 * building was drawn with so the windows line up. */
export function drawNightLights(ctx, what, x, foot, size) {
  if (!ctx || !what || !(size > 0)) return;
  const dpr = scaleOf(ctx);
  const calm = !!what.calm;
  let parts;
  let make;
  if (what.landmark !== undefined) {
    const id = LANDMARKS.has(what.landmark) ? what.landmark : 'default';
    parts = { shape: 'lights-landmark', id, calm, night: true, dpr, seed: 0 };
    make = (s) => render({
      scene: (p) => landmarkScene(p, what.landmark), lightsOnly: true,
      size: s, calm, night: true, dpr, fitMode: LANDMARK_UNITS, fitKey: `l|${id}`,
    });
  } else if (what.house) {
    const turn = houseTurn(what.seed);
    const tier = tierIndex(what.tier);
    const kind = HOUSE_TIERS[tier];
    parts = { shape: 'lights-house', id: kind, calm, night: true, dpr, seed: turn };
    make = (s) => render({
      scene: (p) => houseScene(p, turn, tier), lightsOnly: true,
      size: s, calm, night: true, dpr, fitMode: HOUSE_UNITS, fitKey: `h|${kind}`,
    });
  } else {
    const t = Math.max(0, Math.min(TIER_COUNT - 1, Math.round(what.tier) || 0));
    const seed = what.seed | 0;
    parts = { shape: 'lights-settlement', id: t, calm, night: true, dpr, seed };
    make = (s) => render({
      scene: (p) => settlementScene(p, t, seed), lightsOnly: true,
      size: s, calm, night: true, dpr, fitMode: 'width', fitKey: `s|${t}|${seed}|1`,
    });
  }
  let e = sharpEntry(parts, size, make);
  if (e && e.lights.length && !e.glow) {
    // The glow is a picture too: count it in the budget, and give up on the
    // real-size one if it would be huge.
    try { e.glow = makeGlow(e); } catch { e.glow = null; }
    const px = e.glow ? e.glow.canvas.width * e.glow.canvas.height : 0;
    if (!e.glow || px > MAX_ONE_PX) {
      e.glow = null;
      e.skip = true;
      e = null;
    } else {
      e.px = px;
      sharpPx += px;
      trimSharp(e.key);
    }
  }
  if (!e) e = entryFor(cacheKey({ ...parts, size }), () => make(stepSize(size)));
  if (!e.lights.length) return;
  if (!e.glow) {
    try { e.glow = makeGlow(e); } catch { e.glow = null; }
    if (!e.glow) e.lights = []; // could not paint: do not retry every frame
  }
  const g = e.glow;
  if (!g) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const f = size / e.step;
  ctx.drawImage(g.canvas, x + g.left * f, foot + g.top * f, g.w * f, g.h * f);
  ctx.restore();
}

/** The soft pools of light of one entry, painted once into their own canvas. */
function makeGlow(e) {
  const l = Math.floor(Math.min(...e.lights.map((p) => p.x - p.r)));
  const r = Math.ceil(Math.max(...e.lights.map((p) => p.x + p.r)));
  const t = Math.floor(Math.min(...e.lights.map((p) => p.y - p.r)));
  const b = Math.ceil(Math.max(...e.lights.map((p) => p.y + p.r)));
  const w = Math.max(1, r - l);
  const h = Math.max(1, b - t);
  const dpr = e.dpr;
  const canvas = makeCanvas(Math.ceil(w * dpr), Math.ceil(h * dpr));
  const cx = canvas.getContext('2d');
  if (!cx) return null;
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  e.lights.forEach((p) => {
    const g = cx.createRadialGradient(p.x - l, p.y - t, 0, p.x - l, p.y - t, p.r);
    const rgb = parseInt(p.color.slice(1), 16);
    const c = `${(rgb >> 16) & 255},${(rgb >> 8) & 255},${rgb & 255}`;
    g.addColorStop(0, `rgba(${c},${p.a})`);
    g.addColorStop(0.45, `rgba(${c},${p.a * 0.35})`);
    g.addColorStop(1, `rgba(${c},0)`);
    cx.fillStyle = g;
    cx.fillRect(p.x - l - p.r, p.y - t - p.r, p.r * 2, p.r * 2);
  });
  return { canvas, left: l, top: t, w, h };
}

/** For tests and tuning. */
export const _cacheSize = () => cache.size;
export const _clearCache = () => { cache.clear(); fitCache.clear(); sharpCache.clear(); sharpPx = 0; };
export const _sharpPixels = () => sharpPx;
