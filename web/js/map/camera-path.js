// The path the camera takes between two views (zoomTo, showAll in index.js).
//
// A view is { scale, x, y }: a world point P stands at P * scale + (x, y) on the
// screen. The zoom changes geometrically (so it feels even), and (x, y) follows
// from it in such a way that the whole move is ONE zoom about a fixed point of
// the screen (the point that stays where it is in both views; a pure pan when the
// scale does not change). So a post you tap grows and slides to its spot in a
// straight line, and nothing lurches sideways first.
//
// The earlier version moved (x, y) in a straight line while the scale changed
// geometrically: the ground then zoomed about the middle of the screen at the
// start and drifted to the post afterwards, and a zoom out to the whole map
// swung past the edge of the world (the fog) on the way (2026-10-25, the user).
// Here every edge of the window on the world lies between its edge in the first
// view and in the last one, so if neither shows the fog, nor does the move.

/** The share (0..1) of the way from the first view's x/y to the last one's at
 * scale `s`, for a move from `s0` to `s1`. */
export function slideShare(s0, s1, s, k) {
  // Practically no zoom: a plain pan, in step with the easing.
  if (!(s0 > 0) || !(s1 > 0) || Math.abs(Math.log(s1 / s0)) < 1e-3) return k;
  return (s - s0) / (s1 - s0);
}

/** The view `k` (0..1, already eased) of the way from `from` to `to`. */
export function cameraAt(from, to, k) {
  const scale = from.scale * (to.scale / from.scale) ** k;
  const share = k <= 0 ? 0 : k >= 1 ? 1 : slideShare(from.scale, to.scale, scale, k);
  return {
    scale,
    x: from.x + (to.x - from.x) * share,
    y: from.y + (to.y - from.y) * share,
  };
}

/** The view that has world point (wx, wy) at screen point (ax, ay) at `scale`. */
export function viewHolding(wx, wy, ax, ay, scale) {
  return { scale, x: ax - wx * scale, y: ay - wy * scale };
}
