// HeatObject for the compose screen: the ball or flame that follows the heat
// slider, drawn as SVG. Ported from the design mock's HeatObject.tsx; the map
// draws the same object on a canvas, and both read the colours and outlines from
// heat.js, so the two cannot drift apart.
//
//   not touched yet  grey ball, still
//   0-30             lime ball, drifting slowly
//   31-65            orange ball, drifting a little quicker
//   66-90            red-orange flame, swaying; bigger the higher the number
//   91-100           blue flame, shaking hard; bigger still
//
// Between those it does not jump: every number has its own shape and colour
// (heatMorph), so dragging the slider stretches the ball into a flame and back.
// The motion is driven from here, frame by frame, because a CSS animation cannot
// change its speed or reach halfway through without jumping.

import {
  FLAME_BODY, FLAME_CORE_PATH, FLAME_INNER_PATH, heatMorph, mixHex, morphMotion, outlinePath,
} from '../heat.js';
import { REDUCED_MOTION } from '../map/decor.js';

const GRAY = { light: '#FFFFFF', main: '#C9CED6', dark: '#9AA1AB' };
const SVG = 'http://www.w3.org/2000/svg';
// How quickly the drawing catches up with the slider, in seconds: a tap that
// jumps the number still slides the shape there.
const FOLLOW = 0.09;
// From grey to coloured once the slider is first touched.
const WAKE = 0.3;
let serial = 0;
let greyBall = null;   // the untouched ball's outline (heatMorph(0)), made once

function make(parent, tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
  parent.append(node);
  return node;
}

/** The transform that sways an outline about (x, y), as canvas's transform() would. */
const swayAbout = (x, y, sx, sy, skew) => `translate(${x} ${y}) matrix(${sx.toFixed(4)} 0 ${(Math.sin(skew) * sy).toFixed(4)} ${(Math.cos(skew) * sy).toFixed(4)} 0 0) translate(${-x} ${-y})`;
const scaleAbout = (x, y, sx, sy = sx) => `translate(${x} ${y}) scale(${sx.toFixed(4)} ${sy.toFixed(4)}) translate(${-x} ${-y})`;

/**
 * @param size  one side of the box, in px
 * @returns {{ node: HTMLElement, set(value: number, inactive?: boolean): void }}
 */
export function heatObject(size = 96) {
  serial += 1;
  const node = document.createElement('div');
  node.className = 'heat-object';
  node.style.width = `${size}px`;
  node.style.height = `${size}px`;
  node.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.style.overflow = 'visible';
  node.append(svg);

  // Built once; every frame only changes attributes.
  const id = `heat-body-${serial}`;
  const gradient = make(make(svg, 'defs'), 'radialGradient', { id, cx: '35%', cy: '30%', r: '75%' });
  const stops = ['0%', '55%', '100%'].map((offset) => make(gradient, 'stop', { offset }));
  const shadow = make(svg, 'ellipse', { cx: 50, cy: 90, rx: 18, ry: 4, fill: '#000' });
  const lift = make(svg, 'g');
  const outline = make(lift, 'g');
  const glow = make(outline, 'path', { transform: scaleAbout(50, FLAME_BODY.bottom, 1.12) });
  const body = make(outline, 'path', { fill: `url(#${id})` });
  const shine = make(outline, 'g');
  const ballShine = [
    make(shine, 'ellipse', { cx: 42, cy: 46, rx: 7, ry: 4.5, fill: '#FFFFFF', transform: 'rotate(-30 42 46)' }),
    make(shine, 'circle', { cx: 55, cy: 42, r: 1.8, fill: '#FFFFFF' }),
  ];
  const flameShine = make(outline, 'ellipse', { cx: 28, cy: 40, rx: 3, ry: 6, fill: '#FFFFFF' });
  const heart = make(lift, 'g');
  const inner = make(heart, 'path', { d: FLAME_INNER_PATH });
  const core = make(heart, 'path', { d: FLAME_CORE_PATH });

  let target = 0;        // the slider's number
  let shown = null;      // the number being drawn, catching up with target
  let awake = 0;         // 0 grey and still .. 1 coloured and moving
  let wanted = 0;        // where awake is going
  let clock = 0;         // seconds of motion so far
  let last = 0;
  let raf = 0;
  let parked = false;    // stopped because the screen went away

  function paint(still) {
    const m = heatMorph(shown);
    const motion = morphMotion(m, still ? null : clock);
    const a = awake;
    const flame = m.flame * a;
    const grey = (key) => mixHex(GRAY[key], m.body[key], a);
    stops[0].setAttribute('stop-color', grey('light'));
    stops[1].setAttribute('stop-color', grey('main'));
    stops[2].setAttribute('stop-color', grey('dark'));

    // A grey ball until touched: the outline only becomes the number's shape as
    // it wakes, so the first touch grows the flame out of the ball.
    greyBall = greyBall || heatMorph(0).points;
    const points = greyBall.map((value, i) => value + (m.points[i] - value) * a);
    const d = outlinePath(points);
    body.setAttribute('d', d);
    glow.setAttribute('d', d);
    glow.setAttribute('fill', m.outer);
    glow.setAttribute('opacity', (0.25 * flame).toFixed(3));
    outline.setAttribute('opacity', (0.6 + 0.4 * a).toFixed(3));

    ballShine.forEach((part, i) => part.setAttribute('opacity', ((i ? 0.6 : 0.75) * (1 - flame) ** 2).toFixed(3)));
    // The flame's own glint rides the flame's outline as it grows.
    flameShine.setAttribute('opacity', (0.5 * flame).toFixed(3));
    flameShine.setAttribute('transform', `${scaleAbout(50, FLAME_BODY.bottom, m.scale)} rotate(-30 28 40)`);

    const bob = motion.bob * 1.8 * a;
    lift.setAttribute('transform', `translate(0 ${(-bob).toFixed(2)})`);
    outline.setAttribute('transform', swayAbout(50, FLAME_BODY.bottom, 1 + (motion.sx - 1) * a, 1 + (motion.sy - 1) * a, motion.skew * a));
    shadow.setAttribute('rx', (18 * (1 - bob * 0.025)).toFixed(2));
    shadow.setAttribute('opacity', (((0.27 - bob * 0.016) * a + 0.15 * (1 - a)) * (1 - flame)).toFixed(3));

    // The flame's inside grows up from its base as the ball turns into flame,
    // standing on the outline's lowest point (points[19]: the end of the third
    // curve) so it never shows below a ball that is still round.
    const rise = points[19] - FLAME_BODY.bottom;
    const grow = 0.3 + 0.7 * flame;
    inner.setAttribute('fill', m.inner);
    core.setAttribute('fill', m.core);
    heart.setAttribute('opacity', Math.max(0, Math.min(1, (flame - 0.25) / 0.5)).toFixed(3));
    heart.setAttribute('transform', `translate(0 ${rise.toFixed(2)}) ${scaleAbout(50, FLAME_BODY.bottom, m.scale)} ${scaleAbout(50, FLAME_BODY.innerBottom, grow * (1 + (motion.innerSx - 1) * a), grow * (1 + (motion.innerSy - 1) * a))}`);
  }

  function frame(now) {
    raf = 0;
    // Off screen (another screen is up): stop until the next set().
    if (!node.isConnected || node.offsetParent === null) {
      last = 0;
      parked = true;
      return;
    }
    const still = REDUCED_MOTION;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    if (still) {
      shown = target;
      awake = wanted;
    } else {
      clock += dt;
      shown += (target - shown) * (1 - Math.exp(-dt / FOLLOW));
      if (Math.abs(target - shown) < 0.05) shown = target;
      awake = wanted > awake ? Math.min(wanted, awake + dt / WAKE) : Math.max(wanted, awake - dt / WAKE);
    }
    paint(still);
    // Holding still: one picture is enough. Otherwise it keeps moving.
    if (!still && (awake > 0 || shown !== target)) raf = requestAnimationFrame(frame);
  }

  function wake() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  return {
    node,
    set(value, inactive = false) {
      target = Math.max(0, Math.min(100, Number(value) || 0));
      wanted = inactive ? 0 : 1;
      // Opening the screen (or coming back to it) starts where it is, without
      // sliding over from where it was the last time.
      if (shown === null || inactive || parked) {
        shown = target;
        awake = wanted;
      }
      parked = false;
      wake();
    },
  };
}
