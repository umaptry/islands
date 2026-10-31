// The ground's pixels, built off the page's thread (2026-10-16): the whole-map
// texture ('ground') and the sharp close-up one ('detail'). The page posts the
// job through offthread.js and only puts the pixels on a canvas.

import { useConfig } from '../config.js';
import { detailPixels, groundPixels } from './terrain.js';
import { setIslandB, setIslandBView } from './island-b.js';

const BUILD = { ground: groundPixels, detail: detailPixels };

self.onmessage = (event) => {
  const { id, kind, config, job, islandB } = event.data;
  if (config) useConfig(config);
  // Map plan B: the island (only when it changed) and what the ground depends on.
  if (islandB) {
    if (islandB.payload) setIslandB(islandB.payload);
    setIslandBView(islandB.view);
  }
  try {
    const built = BUILD[kind](job);
    if (!built) {
      self.postMessage({ id, built: null });
      return;
    }
    self.postMessage({ id, built }, [built.pixels.buffer]);
  } catch (error) {
    self.postMessage({ id, error: String((error && error.message) || error) });
  }
};
