// The sea's own furniture: chart hatching, small boats, gulls, surf.
//
// None of it carries data. No boat is a person, no bird is a post, and nothing
// here touches the camera, the coordinates or the hit list, so decoration can
// never move an island or swallow a tap. It exists because a map of islands
// with nothing moving on it reads as a diagram rather than as a place.
//
// Everything is positioned as a pure function of the clock, never as an
// accumulated velocity: a backgrounded tab, a resize or a dropped frame cannot
// drift the fleet or leave a bird somewhere it should not be.

export const REDUCED_MOTION = Boolean(
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
);

export const INK = {
  seaMark: 'rgba(255, 255, 255, .17)',
  surf: 'rgba(255, 255, 255, .58)',
  bird: 'rgba(255, 255, 255, .62)',
  boat: 'rgba(255, 255, 255, .92)',
  wake: 'rgba(255, 255, 255, .3)',
  halo: 'rgba(23, 46, 74, .55)',
  label: '#ffffff',
};

/** Deterministic 0..1 from a seed and an index. */
export function noise(seed, index) {
  const value = Math.sin(seed * 0.0001 + index * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

/** FNV-1a over an id. Same post, same island shape, on every device. */
export function hashId(id) {
  let hash = 2166136261;
  const text = String(id);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const BOAT_COUNT = 6;
// Screen pixels at every zoom. A boat that grew with the map would compete with
// the islands; the point is that it stays tiny.
const BOAT_LENGTH = 7;
const SEA_MARK_COUNT = 44;
const BIRD_SKEINS = 2;
const BIRD_SIZE = 2.6;

/** A chord across the sea box, eased back and forth.
 *
 * Built as a pair of points either side of the middle rather than two free
 * points: two free points can land close together, and something on a short leg
 * turns around every few seconds, which reads as fidgeting rather than as a
 * crossing.
 */
function chord(sea, seed, spread) {
  const angle = noise(seed, 1) * Math.PI * 2;
  const reach = spread + noise(seed, 2) * 0.12;
  const shift = (noise(seed, 3) - 0.5) * 0.18;
  const midX = sea.x + sea.w / 2;
  const midY = sea.y + sea.h / 2;
  const armX = Math.cos(angle) * sea.w * reach;
  const armY = Math.sin(angle) * sea.h * reach;
  const offX = -Math.sin(angle) * sea.w * shift;
  const offY = Math.cos(angle) * sea.h * shift;
  return {
    ax: midX + offX - armX, ay: midY + offY - armY,
    bx: midX + offX + armX, by: midY + offY + armY,
  };
}

export function drawSeaMarks(ctx, view, time) {
  const { sea, toScreen, width, height } = view;
  ctx.save();
  ctx.strokeStyle = INK.seaMark;
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  for (let i = 0; i < SEA_MARK_COUNT; i += 1) {
    const seed = 104729 * (i + 1);
    const spot = toScreen(sea.x + noise(seed, 1) * sea.w, sea.y + noise(seed, 2) * sea.h);
    if (spot.x < -20 || spot.x > width + 20 || spot.y < -20 || spot.y > height + 20) continue;
    const sway = REDUCED_MOTION ? 0 : Math.sin(time * 0.6 + noise(seed, 3) * Math.PI * 2) * 1.3;
    const unit = 3.2;
    ctx.beginPath();
    for (let row = 0; row < 2; row += 1) {
      const y = spot.y + row * 2.6;
      const x = spot.x + sway + row * 1.4;
      ctx.moveTo(x - unit, y);
      ctx.quadraticCurveTo(x - unit * 0.5, y - 1.5, x, y);
      ctx.quadraticCurveTo(x + unit * 0.5, y + 1.5, x + unit, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

export function drawBoats(ctx, view, time) {
  if (REDUCED_MOTION) return;
  const { sea, toScreen, width, height } = view;
  // World units per second, tuned so one crossing takes the better part of a
  // minute. Slow enough that the map still reads as a still map.
  const speed = Math.max(sea.w, sea.h) / 55;
  for (let i = 0; i < BOAT_COUNT; i += 1) {
    const seed = 7919 * (i + 1);
    const { ax, ay, bx, by } = chord(sea, seed, 0.28);
    const span = Math.hypot(bx - ax, by - ay);
    if (span < 1) continue;
    const cycle = (time / ((2 * span) / speed) + noise(seed, 5)) * Math.PI * 2;
    const travel = 0.5 - Math.cos(cycle) * 0.5;
    const point = toScreen(ax + (bx - ax) * travel, ay + (by - ay) * travel);
    if (point.x < -40 || point.x > width + 40 || point.y < -40 || point.y > height + 40) continue;
    const bob = Math.sin(time * 1.1 + noise(seed, 6) * Math.PI * 2) * 0.6;
    const outbound = Math.sin(cycle) >= 0;
    drawBoat(ctx, point.x, point.y + bob, (bx >= ax) === outbound ? 1 : -1);
  }
}

function drawBoat(ctx, x, y, facing) {
  const unit = BOAT_LENGTH;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(facing, 1);

  const wake = ctx.createLinearGradient(-unit * 2.6, 0, -unit * 0.4, 0);
  wake.addColorStop(0, 'rgba(255, 255, 255, 0)');
  wake.addColorStop(1, INK.wake);
  ctx.strokeStyle = wake;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-unit * 2.6, unit * 0.26);
  ctx.lineTo(-unit * 0.4, unit * 0.26);
  ctx.stroke();

  ctx.fillStyle = INK.boat;
  ctx.beginPath();
  ctx.moveTo(-unit * 0.5, -unit * 0.1);
  ctx.lineTo(unit * 0.5, -unit * 0.1);
  ctx.lineTo(unit * 0.24, unit * 0.32);
  ctx.lineTo(-unit * 0.34, unit * 0.32);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(-unit * 0.06, -unit * 0.16);
  ctx.lineTo(-unit * 0.06, -unit * 0.95);
  ctx.lineTo(unit * 0.4, -unit * 0.16);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function drawBirds(ctx, view, time) {
  if (REDUCED_MOTION) return;
  const { sea, toScreen, width, height } = view;
  const speed = Math.max(sea.w, sea.h) / 22;
  ctx.save();
  ctx.strokeStyle = INK.bird;
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  for (let flight = 0; flight < BIRD_SKEINS; flight += 1) {
    const seed = 15485863 * (flight + 1);
    const { ax, ay, bx, by } = chord(sea, seed, 0.30);
    const armX = bx - ax;
    const armY = by - ay;
    const span = Math.hypot(armX, armY);
    if (span < 1) continue;
    const cycle = (time / ((2 * span) / speed) + noise(seed, 5)) * Math.PI * 2;
    const travel = 0.5 - Math.cos(cycle) * 0.5;
    const lead = toScreen(ax + armX * travel, ay + armY * travel);
    if (lead.x < -60 || lead.x > width + 60 || lead.y < -60 || lead.y > height + 60) continue;
    // toScreen is a uniform scale plus a translation, so the world direction and
    // the screen direction are the same direction.
    const sign = Math.sin(cycle) >= 0 ? 1 : -1;
    const unitX = (armX * sign) / span;
    const unitY = (armY * sign) / span;
    for (let bird = 0; bird < 3; bird += 1) {
      const back = bird * 7;
      const side = bird === 1 ? -5 : (bird === 2 ? 5 : 0);
      const flap = Math.sin(time * 5.5 + bird * 0.7 + flight) * 0.7;
      drawBird(ctx,
        lead.x - unitX * back - unitY * side,
        lead.y - unitY * back + unitX * side,
        flap);
    }
  }
  ctx.restore();
}

function drawBird(ctx, x, y, flap) {
  const unit = BIRD_SIZE;
  // Wingtips above the body, dipping through the middle: the gull mark. Pull the
  // control points the other way and the same three points draw a dome, which at
  // this size reads as a hill rather than a bird.
  const tip = y - unit * 0.5 - flap;
  ctx.beginPath();
  ctx.moveTo(x - unit, tip);
  ctx.quadraticCurveTo(x - unit * 0.5, y + unit * 0.16, x, y);
  ctx.quadraticCurveTo(x + unit * 0.5, y + unit * 0.16, x + unit, tip);
  ctx.stroke();
}

/** A rounded, irregular blob outline. Used for the orbit view's little islands
 *  and for the surf ring, so both wobble the same way for the same post. */
export function islandPath(ctx, x, y, radius, seed) {
  const COUNT = 11;
  const points = [];
  for (let i = 0; i < COUNT; i += 1) {
    const angle = (i / COUNT) * Math.PI * 2;
    const wobble = 0.74 + noise(seed, i) * 0.46;
    points.push([
      x + Math.cos(angle) * radius * wobble,
      y + Math.sin(angle) * radius * wobble * 0.8,
    ]);
  }
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  ctx.beginPath();
  const start = mid(points[COUNT - 1], points[0]);
  ctx.moveTo(start[0], start[1]);
  for (let i = 0; i < COUNT; i += 1) {
    const control = points[i];
    const end = mid(points[i], points[(i + 1) % COUNT]);
    ctx.quadraticCurveTo(control[0], control[1], end[0], end[1]);
  }
  ctx.closePath();
}

/** Surf around one island, breathing slowly. The one moving thing that belongs
 *  to a post rather than to the decoration: the land somebody wrote is
 *  standing in water. */
export function drawSurf(ctx, x, y, radius, id, time) {
  const seed = hashId(id);
  const swell = REDUCED_MOTION
    ? 1.06
    : 1.06 + Math.sin(time * 0.8 + noise(seed, 9) * Math.PI * 2) * 0.035;
  ctx.save();
  islandPath(ctx, x, y, radius * swell, seed);
  ctx.strokeStyle = INK.surf;
  ctx.lineWidth = Math.max(1.4, radius * 0.11);
  ctx.globalAlpha = 0.38;
  ctx.stroke();
  ctx.restore();
}

/** Screen-space de-clutter for labels.
 *
 * Labels are drawn at every zoom, and crowding is handled where crowding
 * actually happens - in screen pixels. A label is skipped only when it would
 * land on top of one already placed. Space is claimed in priority order:
 * landmass names, then you, then everybody else, so the headline never loses to
 * a passer-by.
 */
export function makeLabelSpace() {
  const taken = [];
  return function claim(x, y, textWidth, textHeight) {
    const left = x - textWidth / 2 - 2;
    const right = x + textWidth / 2 + 2;
    const top = y - textHeight / 2 - 1;
    const bottom = y + textHeight / 2 + 1;
    for (let i = 0; i < taken.length; i += 1) {
      const box = taken[i];
      if (left < box.right && right > box.left && top < box.bottom && bottom > box.top) {
        return false;
      }
    }
    taken.push({ left, right, top, bottom });
    return true;
  };
}
