// The hand-drawn pieces the map is built from: settlements, landmarks, trees,
// gulls. One style throughout (dark-brown outline, two steps of cel shade), cut
// from generated sheets into web/img/map/.
//
// Images load on first use and a sprite that is not ready yet is simply not
// drawn that frame: the map never waits for art, and a missing file costs a
// decoration, never a post.

const BASE = '/static/img/map/';

// Growth tiers, in core/config.py's order: 小屋・村・港町・町・都市.
export const TIER_SPRITES = ['hut', 'village', 'harbor', 'town', 'city'];

// core/config.py LANDMARK_CANDIDATES, by name.
const LANDMARK_FILES = {
  灯台: 'lighthouse', 風車: 'windmill', 時計塔: 'clocktower', 図書館: 'library',
  工房: 'workshop', 温室: 'greenhouse', 天文台: 'observatory', 市場: 'market',
  港の桟橋: 'pier', 鍛冶場: 'smithy', 学び舎: 'school', 茶屋: 'teahouse',
  劇場: 'theater', 庭園: 'garden', 畑: 'farm', 釣り小屋: 'fishhut',
  画廊: 'gallery', 音楽堂: 'musichall', 研究所: 'lab', パン屋: 'bakery',
  診療所: 'clinic', 見張り台: 'watchtower', 運動場: 'field', 広場: 'plaza',
};

export const landmarkSprite = (name) => LANDMARK_FILES[name] || null;

// What travels on the lines between people (lines.js).
const VEHICLES = ['boat_row', 'boat_sail', 'ferry', 'balloon', 'walker_a', 'walker_b'];

const images = new Map();

function image(name) {
  let entry = images.get(name);
  if (!entry) {
    const img = new Image();
    entry = { img, ready: false, failed: false };
    img.onload = () => { entry.ready = true; };
    img.onerror = () => { entry.failed = true; };
    img.src = `${BASE}${name}.png`;
    images.set(name, entry);
  }
  return entry.ready ? entry.img : null;
}

/** Start loading what the first frame will want, so it is not drawn bare. */
export function preloadSprites() {
  [...TIER_SPRITES, 'tree', 'pine', 'bush', 'rock', 'gull_up', 'gull_down', ...VEHICLES].forEach(image);
}

/** Draw a sprite standing on (x, foot): `size` is its longer side in CSS px.
 *
 * Returns the box it covered (for hit tests and label room), or null when the
 * image is not loaded yet.
 */
export function drawSprite(ctx, name, x, foot, size, { alpha = 1, calm = false } = {}) {
  const img = name ? image(name) : null;
  if (!img) return null;
  const k = size / Math.max(img.width, img.height);
  const w = img.width * k;
  const h = img.height * k;
  const box = { left: x - w / 2, top: foot - h, right: x + w / 2, bottom: foot, w, h };
  ctx.save();
  if (alpha < 1) ctx.globalAlpha *= alpha;
  // A quiet island keeps its buildings but lets the colour go out of them.
  // Browsers without canvas filters fall back to the alpha alone.
  if (calm) ctx.filter = 'saturate(55%) brightness(103%)';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, box.left, box.top, w, h);
  ctx.restore();
  return box;
}
