// Music and sound effects ported from the design mock (BGM, map ambience, SE).
// Everything is made on the spot with Web Audio, so there are no files to load.
//
// One AudioContext is shared with feedback.js and is only created after a tap.
// The single "sound" switch in the settings controls all of it. When the switch
// is off, or the tab is in the background, the context is suspended: BGM,
// ambience and effects all go quiet at once and carry on when it comes back.

import { audioContext, feedbackSettings, onFeedbackChange } from './feedback.js';
import { ambientShouldPlay, audioShouldRun, maySe } from './feedback-rules.js';

const MASTER = 0.35; // overall level, kept below the mock so it stays gentle
const BGM_LEVEL = 0.55; // music sits under everything else
const ENV_LEVEL = 0.3;
const BEAT = 60 / 90; // 90 BPM
const LOOP_SECONDS = 16 * BEAT;

let started = false; // first tap has happened
let ctx = null;
let master = null;
let bgmBus = null;
let envBus = null;
let bgmTimer = null;
let nextLoopAt = 0;
let ambientWanted = false;
let ambient = null; // { nodes, timer } while sounding
const lastSe = {};

const hasWindow = typeof window !== 'undefined' && typeof document !== 'undefined';
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

const MELODY = [
  [64, 0, 0.5], [67, 0.5, 0.5], [69, 1, 1], [72, 2.5, 0.5], [69, 3, 1],
  [64, 4, 0.5], [62, 4.5, 0.5], [60, 5, 2],
  [64, 8, 0.5], [67, 8.5, 0.5], [69, 9, 1], [72, 10.5, 0.5], [76, 11, 1],
  [72, 12, 0.5], [69, 12.5, 0.5], [67, 13, 2],
];
const CHORDS = [
  [[48, 55, 60], 0], [[45, 52, 57], 4], [[41, 48, 53], 8], [[43, 50, 55], 12],
];
const BASS = [
  [36, 0, 2], [36, 2.5, 1], [33, 4, 2], [33, 6.5, 1],
  [29, 8, 2], [29, 10.5, 1], [31, 12, 2], [31, 14.5, 1],
];
const ARP = [
  72, 76, 79, 84, 79, 76, 72, 67, 69, 72, 76, 81, 76, 72, 69, 64,
  65, 69, 72, 77, 72, 69, 65, 60, 67, 71, 74, 79, 74, 71, 67, 62,
];

function ensureContext() {
  if (ctx) return ctx;
  ctx = audioContext();
  if (!ctx) return null;
  master = ctx.createGain();
  master.gain.value = MASTER;
  master.connect(ctx.destination);
  bgmBus = ctx.createGain();
  bgmBus.gain.value = BGM_LEVEL;
  bgmBus.connect(master);
  envBus = ctx.createGain();
  envBus.gain.value = ENV_LEVEL;
  envBus.connect(master);
  return ctx;
}

function tone(type, freq, start, dur, peak, out, shape = 'exp') {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peak, start + 0.02);
  if (shape === 'exp') gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
  else gain.gain.linearRampToValueAtTime(0, start + dur);
  osc.connect(gain).connect(out);
  osc.start(start);
  osc.stop(start + dur + 0.1);
}

// --- BGM ---

function scheduleLoop(t) {
  for (const [notes, beat] of CHORDS) {
    for (const n of notes) {
      const s = t + beat * BEAT;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = mtof(n);
      gain.gain.setValueAtTime(0, s);
      gain.gain.linearRampToValueAtTime(0.025, s + 0.5);
      gain.gain.linearRampToValueAtTime(0, s + 4 * BEAT);
      osc.connect(gain).connect(bgmBus);
      osc.start(s);
      osc.stop(s + 4 * BEAT + 0.1);
    }
  }
  for (const [n, beat, len] of BASS) {
    const s = t + beat * BEAT;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = mtof(n);
    gain.gain.setValueAtTime(0, s);
    gain.gain.linearRampToValueAtTime(0.06, s + 0.1);
    gain.gain.linearRampToValueAtTime(0, s + len * BEAT);
    osc.connect(gain).connect(bgmBus);
    osc.start(s);
    osc.stop(s + len * BEAT + 0.1);
  }
  ARP.forEach((n, i) => tone('sine', mtof(n), t + i * 0.5 * BEAT, 0.4, 0.02, bgmBus));
  for (const [n, beat, len] of MELODY) {
    const s = t + beat * BEAT;
    const dur = len * BEAT;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = mtof(n);
    gain.gain.setValueAtTime(0, s);
    gain.gain.linearRampToValueAtTime(0.12, s + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.01, s + Math.max(0.1, dur));
    const lfo = ctx.createOscillator(); // a little vibrato, like a flute
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 5;
    lfoGain.gain.value = 3;
    lfo.connect(lfoGain).connect(osc.frequency);
    lfo.start(s);
    lfo.stop(s + dur + 0.5);
    osc.connect(gain).connect(bgmBus);
    osc.start(s);
    osc.stop(s + dur + 0.5);
  }
}

// Looks a little ahead on the audio clock. While the context is suspended the
// clock stands still, so nothing piles up and the music resumes where it was.
function tickBgm() {
  if (!ctx) return;
  while (nextLoopAt < ctx.currentTime + 3) {
    scheduleLoop(Math.max(nextLoopAt, ctx.currentTime + 0.1));
    nextLoopAt = Math.max(nextLoopAt, ctx.currentTime + 0.1) + LOOP_SECONDS;
  }
}

function startBgm() {
  if (bgmTimer !== null) return;
  tickBgm();
  bgmTimer = setInterval(tickBgm, 1000);
}

function stopBgmTimer() {
  if (bgmTimer !== null) clearInterval(bgmTimer);
  bgmTimer = null;
}

// --- ambience ---

function startAmbient() {
  if (ambient || !ctx) return;
  const size = ctx.sampleRate * 2;
  const buffer = ctx.createBuffer(1, size, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  noise.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 600;
  const gain = ctx.createGain();
  gain.gain.value = 0.2;
  noise.connect(filter).connect(gain).connect(envBus);
  noise.start();
  const lfo = ctx.createOscillator(); // the slow swell of the waves
  lfo.frequency.value = 0.08;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0.15;
  lfo.connect(lfoGain).connect(gain.gain);
  lfo.start();
  ambient = { noise, lfo, nodes: [filter, gain, lfoGain], timer: null };
  scheduleGull();
}

function stopAmbient() {
  if (!ambient) return;
  const a = ambient;
  ambient = null;
  if (a.timer !== null) clearTimeout(a.timer);
  for (const source of [a.noise, a.lfo]) {
    try {
      source.stop();
    } catch {
      // Already stopped.
    }
    source.disconnect();
  }
  a.nodes.forEach((n) => n.disconnect());
}

function scheduleGull() {
  if (!ambient) return;
  ambient.timer = setTimeout(() => {
    if (!ambient) return;
    gull();
    scheduleGull();
  }, 10000 + Math.random() * 15000);
}

function gull() {
  if (!ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime;
  let out = envBus;
  if (ctx.createStereoPanner) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.random() * 2 - 1;
    panner.connect(envBus);
    out = panner;
  }
  const count = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < count; i++) {
    const s = now + i * 0.4;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(850, s);
    osc.frequency.exponentialRampToValueAtTime(300, s + 0.3);
    gain.gain.setValueAtTime(0, s);
    gain.gain.linearRampToValueAtTime(0.1, s + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.01, s + 0.3);
    osc.connect(gain).connect(out);
    osc.start(s);
    osc.stop(s + 0.4);
  }
}

// --- following the settings and the tab ---

function apply() {
  if (!started || !ctx) return;
  const settings = feedbackSettings();
  const hidden = hasWindow && document.hidden;
  if (audioShouldRun(settings, hidden)) {
    ctx.resume().catch(() => {});
    startBgm();
    if (ambientShouldPlay(ambientWanted, settings, hidden)) startAmbient();
    else stopAmbient();
  } else {
    stopAmbient();
    stopBgmTimer();
    ctx.suspend().catch(() => {});
  }
}

/** Start BGM on the first user gesture (respects the sound setting). */
export function setupAudio() {
  if (!hasWindow) return;
  // Touch pointerdown does not count as a user activation (iOS Safari), so
  // listen to every gesture. The listeners stay: after a phone call or Siri the
  // context is "interrupted" and only a later tap can wake it, so each gesture
  // tries again whenever it is not running (a cheap check).
  const GESTURES = ['pointerdown', 'touchend', 'click', 'keydown'];
  const wake = () => {
    if (!started) {
      if (!ensureContext()) return;
      started = true;
      apply();
      return;
    }
    if (ctx && ctx.state !== 'running') apply();
  };
  GESTURES.forEach((name) => window.addEventListener(name, wake, { passive: true }));
  document.addEventListener('visibilitychange', apply);
  onFeedbackChange(apply);
}

/** Map ambience (waves + gulls) on/off. Called by the map screen. */
export function setAmbient(on) {
  ambientWanted = Boolean(on);
  apply();
}

/** One-shot effect: 'success' | 'click' | 'hardClick' | 'pop' | 'fanfare'. */
export function playSe(name) {
  if (!started || !ctx || ctx.state !== 'running') return;
  const now = Date.now();
  if (!maySe(name, feedbackSettings(), hasWindow && document.hidden, lastSe[name] || 0, now)) return;
  lastSe[name] = now;
  const t = ctx.currentTime + 0.01;
  if (name === 'success') {
    tone('sine', 523.25, t, 0.2, 0.3, master);
    tone('sine', 659.25, t + 0.1, 0.2, 0.3, master);
    tone('sine', 783.99, t + 0.2, 0.4, 0.3, master);
  } else if (name === 'click') {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(600, t);
    osc.frequency.exponentialRampToValueAtTime(300, t + 0.4);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.2, t + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.01, t + 0.4);
    osc.connect(gain).connect(master);
    osc.start(t);
    osc.stop(t + 0.45);
  } else if (name === 'hardClick') {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(800, t);
    osc.frequency.exponentialRampToValueAtTime(100, t + 0.02);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.15, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.01, t + 0.03);
    osc.connect(gain).connect(master);
    osc.start(t);
    osc.stop(t + 0.04);
  } else if (name === 'pop') {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(400, t);
    osc.frequency.exponentialRampToValueAtTime(800, t + 0.1);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.3, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.01, t + 0.15);
    osc.connect(gain).connect(master);
    osc.start(t);
    osc.stop(t + 0.2);
  } else if (name === 'fanfare') {
    const note = (freq, start, dur, vol, vibrato) => {
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(vol, start + 0.015);
      gain.gain.setValueAtTime(vol * 0.8, start + Math.min(0.1, dur * 0.5));
      gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
      gain.connect(master);
      for (const type of ['square', 'triangle']) {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, start);
        const level = ctx.createGain();
        level.gain.value = type === 'square' ? 0.25 : 0.75;
        if (vibrato) {
          const lfo = ctx.createOscillator();
          const lfoGain = ctx.createGain();
          lfo.frequency.value = 6;
          lfoGain.gain.setValueAtTime(0, start);
          lfoGain.gain.linearRampToValueAtTime(freq * 0.012, start + 0.3);
          lfo.connect(lfoGain).connect(osc.frequency);
          lfo.start(start);
          lfo.stop(start + dur + 0.1);
        }
        osc.connect(level).connect(gain);
        osc.start(start);
        osc.stop(start + dur + 0.1);
      }
    };
    note(783.99, t, 0.12, 0.18, false);
    note(783.99, t + 0.14, 0.12, 0.18, false);
    const r = t + 0.3;
    note(1046.5, r, 1.4, 0.16, true);
    note(659.25, r, 1.4, 0.1, true);
    note(783.99, r, 1.4, 0.08, true);
    note(261.63, r, 1.2, 0.12, false);
  }
}
