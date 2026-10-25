// The sound of the sea on the map: waves that swell and break on a shore, and gulls by day.
//
// Two halves. The top is plain rules (no browser): how one swell is shaped, how long it lasts,
// when a bigger set comes, and when gulls may call. The bottom builds the swells with Web Audio
// on any context it is given (a live one, or an OfflineAudioContext when the sound is measured).
// Everything is made on the spot; there are no sound files.

// ---------------------------------------------------------------- rules

/** Gulls call in the morning, day and evening of the map's time of day - never at night. */
export const GULL_TIMES = Object.freeze(['morning', 'day', 'evening']);

export function gullsAllowed(tod) {
  return GULL_TIMES.includes(tod);
}

export const SWELL_MIN_S = 6;
export const SWELL_MAX_S = 11;
/** Level between two swells: the sea never goes dead silent, but it is far below a swell. */
export const SWELL_FLOOR = 0.04;
/** Where in a swell (0 build-up .. 1 gone) the wave breaks. */
export const BREAK_AT = 0.4;

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/**
 * The loudness of one swell over its own length, x = 0 .. 1 (0 to 1 to 0).
 * A slow build (ease-in) up to the break, a quick fall just after it, then a long hiss-out.
 */
export function swellShape(x) {
  const t = clamp01(x);
  if (t <= BREAK_AT) return (t / BREAK_AT) ** 2.2;
  const after = (t - BREAK_AT) / (1 - BREAK_AT);
  // 1 -> about 0.7 straight after the break, then an exponential run-out to 0 at the end.
  const settle = 1 - 0.3 * Math.min(1, after / 0.12);
  const run = (Math.exp(-3.4 * after) - Math.exp(-3.4)) / (1 - Math.exp(-3.4));
  return settle * run;
}

/** The white foam of the break: nothing until the wave tips over, then a burst that fades out slowly. */
export function foamShape(x) {
  const t = clamp01(x);
  const start = BREAK_AT - 0.06;
  if (t <= start) return 0;
  const rise = Math.min(1, (t - start) / 0.1);
  const after = Math.max(0, (t - BREAK_AT) / (1 - BREAK_AT));
  return rise * Math.exp(-2.6 * after) * (1 - after * 0.2) ** 2;
}

/**
 * The plan for the next swell. `random` is Math.random (or a seeded stand-in in tests);
 * `sinceBig` counts the swells since the last bigger one ("a set").
 */
export function swellPlan(random, sinceBig = 0) {
  const big = sinceBig >= 3 && random() < 0.35 + 0.15 * (sinceBig - 3);
  const period = big ? 9 + random() * (SWELL_MAX_S - 9) : SWELL_MIN_S + random() * (SWELL_MAX_S - SWELL_MIN_S);
  const peak = big ? 0.95 + random() * 0.05 : 0.4 + random() * 0.35;
  const side = random() < 0.5 ? -1 : 1;
  return {
    big,
    period,
    peak,
    // The cut-off of the low-pass opens with the swell, so a big swell sounds brighter.
    cutLow: 200,
    cutHigh: big ? 1700 : 950 + peak * 500,
    // The wave rolls along the shore: it starts to one side and ends on the other.
    pan0: side * (0.15 + random() * 0.35),
    pan1: -side * (0.1 + random() * 0.4),
  };
}

/** The gain of the swells and of the foam, as arrays for setValueCurveAtTime. */
export function swellCurves(plan, points = 96) {
  const gain = new Float32Array(points);
  const cutoff = new Float32Array(points);
  const foam = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const x = i / (points - 1);
    const s = swellShape(x);
    gain[i] = SWELL_FLOOR + (plan.peak - SWELL_FLOOR) * s;
    cutoff[i] = plan.cutLow + (plan.cutHigh - plan.cutLow) * s ** 0.8;
    foam[i] = plan.peak * 0.8 * foamShape(x);
  }
  return { gain, cutoff, foam };
}

// ---------------------------------------------------------------- Web Audio

/** Brown (red) noise, a different run in each channel: dark and rumbling instead of hissing.
 * The second half is the first read backwards, so the loop joins without a click. */
export function brownNoiseBuffer(context, seconds = 8, random = Math.random) {
  const size = Math.floor(context.sampleRate * seconds);
  const half = size >> 1;
  const buffer = context.createBuffer(2, size, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let last = 0;
    for (let i = 0; i < half; i++) {
      last = (last + 0.02 * (random() * 2 - 1)) / 1.02; // a leaky sum of white noise
      data[i] = last * 3.5;
      data[size - 1 - i] = data[i];
    }
  }
  return buffer;
}

/**
 * Waves into `out`. Call `scheduleUntil(time)` now and then (the audio clock's time): it lays down
 * whole swells ahead, one after another. `stop()` ends it.
 */
export function createWaves(context, out, { random = Math.random, level = 1 } = {}) {
  const buffer = brownNoiseBuffer(context, 8, random);
  const source = (offset) => {
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.loop = true;
    node.start(0, offset);
    return node;
  };
  const master = context.createGain();
  master.gain.value = level;
  master.connect(out);

  // The body of the wave: dark noise through a low-pass that opens as the swell grows.
  const body = source(0);
  const lowpass = context.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.Q.value = 0.6;
  lowpass.frequency.value = 200;
  const swell = context.createGain();
  swell.gain.value = SWELL_FLOOR;
  const pan = context.createStereoPanner ? context.createStereoPanner() : null;
  body.connect(lowpass).connect(swell);
  if (pan) swell.connect(pan).connect(master);
  else swell.connect(master);

  // The foam: a soft band of the same sea, only after the break.
  const spray = source(3.1);
  const high = context.createBiquadFilter();
  high.type = 'highpass';
  high.frequency.value = 500;
  const soft = context.createBiquadFilter();
  soft.type = 'lowpass';
  soft.frequency.value = 2200;
  const softer = context.createBiquadFilter(); // two stages: steeper, so almost nothing reaches the highs
  softer.type = 'lowpass';
  softer.frequency.value = 2200;
  const foam = context.createGain();
  foam.gain.value = 0;
  spray.connect(high).connect(soft).connect(softer).connect(foam).connect(master);

  const nodes = [body, spray, lowpass, swell, pan, high, soft, softer, foam, master].filter(Boolean);
  let next = 0;
  let sinceBig = 0;
  let stopped = false;

  function lay(at) {
    const plan = swellPlan(random, sinceBig);
    sinceBig = plan.big ? 0 : sinceBig + 1;
    const length = plan.period - 0.02; // curves may touch but not overlap
    const curves = swellCurves(plan);
    swell.gain.setValueCurveAtTime(curves.gain, at, length);
    lowpass.frequency.setValueCurveAtTime(curves.cutoff, at, length);
    foam.gain.setValueCurveAtTime(curves.foam, at, length);
    if (pan) {
      pan.pan.setValueAtTime(plan.pan0, at);
      pan.pan.linearRampToValueAtTime(plan.pan1, at + length);
    }
    return plan.period;
  }

  return {
    scheduleUntil(time, from = time) {
      if (stopped) return;
      if (next === 0) next = from + 0.1;   // the sea starts with a swell building up
      while (next < time) next += lay(next);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const node of [body, spray]) {
        try { node.stop(); } catch { /* already stopped */ }
      }
      nodes.forEach((node) => node.disconnect());
    },
  };
}
