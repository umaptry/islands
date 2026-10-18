// The picture files the map still loads from web/img/map/: the whale's shadow,
// the plane and the fog. (Towns, landmarks and trees are drawn in code now,
// buildings.js.)
//
// Images load on first use and a sprite that is not ready yet is simply not
// drawn that frame: the map never waits for art, and a missing file costs a
// decoration, never a post.

const BASE = '/static/img/map/';

// Sea life and air traffic, seen from above and facing right: whale.png is the
// whale's shadow, plane.png rides the arches between islands. Both may be
// missing; they are then simply not drawn.
const SEA_AND_SKY = ['whale', 'plane', 'fog'];

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

/** The fog picture (fog.png, a square: clear in the middle third, solid white
 * at the rim), or null while it loads or when the file is missing - the caller
 * then makes the same picture in code. */
export function fogImage() {
  return image('fog');
}

/** Start loading what the first frame will want, so it is not drawn bare. */
export function preloadSprites() {
  SEA_AND_SKY.forEach(image);
}

/** Draw a sprite centred on (x, y), turned to `angle` (radians, 0 = facing
 * right) - for things seen from above: a whale's shadow, a plane. `size` is the
 * longer side in CSS px. Returns false when the image is not loaded.
 */
export function drawSpriteTurned(ctx, name, x, y, size, angle = 0, { alpha = 1 } = {}) {
  const img = image(name);
  if (!img) return false;
  const k = size / Math.max(img.width, img.height);
  const w = img.width * k;
  const h = img.height * k;
  ctx.save();
  if (alpha < 1) ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
  return true;
}
