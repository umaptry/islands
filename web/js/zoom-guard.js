// Keeps the page itself from being zoomed by pinch or double tap. iOS Safari
// ignores user-scalable=no, so the WebKit gesture events are stopped here.
// The map canvas does its own pinch from touch events, which this never touches.

/** Should this gesture event (gesturestart/change/end) be cancelled? Always: the
 *  page never zooms, and the map reads touches, not gesture events. */
export function blocksGesture(type) {
  return type === 'gesturestart' || type === 'gesturechange' || type === 'gestureend';
}

/** Should a touchmove be cancelled? Only a 2+ finger move that is not on the map. */
export function blocksPinchMove(touchCount, onMap) {
  return touchCount >= 2 && !onMap;
}

let installed = false;

export function setupZoomGuard(doc = document) {
  if (installed) return;
  installed = true;
  const stop = (event) => { if (blocksGesture(event.type)) event.preventDefault(); };
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    doc.addEventListener(type, stop, { passive: false });
  }
  // Other browsers: a two-finger move outside the map must not zoom the page.
  doc.addEventListener('touchmove', (event) => {
    const onMap = !!(event.target && event.target.closest && event.target.closest('#stage'));
    if (blocksPinchMove(event.touches ? event.touches.length : 0, onMap)) event.preventDefault();
  }, { passive: false });
}
