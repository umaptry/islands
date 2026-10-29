// The pure decisions behind the full-screen image viewer (components/image-viewer.js).
// No DOM in here, so node --test can run them.

/** Pixels you must pull the image down, and how fast a shorter flick must be, to close it. */
export const SWIPE_DISTANCE = 110;
export const SWIPE_FLICK_DISTANCE = 40;
export const SWIPE_FLICK_SPEED = 0.55; // px per ms

/** Whether a drag that has just been let go closes the viewer. Downwards and mostly vertical only. */
export function shouldDismissSwipe({ dx = 0, dy = 0, elapsedMs = 0 } = {}) {
  if (!(dy > 0) || Math.abs(dy) <= Math.abs(dx)) return false;
  if (dy >= SWIPE_DISTANCE) return true;
  return dy >= SWIPE_FLICK_DISTANCE && elapsedMs > 0 && dy / elapsedMs >= SWIPE_FLICK_SPEED;
}

/** How much of the dark backdrop is left while the image is pulled down: 1 at rest, fading to 0.25. */
export function dragBackdrop(dy, height = 800) {
  if (!(dy > 0)) return 1;
  const span = Math.max(1, height * 0.5);
  return Math.max(0.25, 1 - Math.min(1, dy / span) * 0.75);
}

/**
 * The buttons on the viewer's reaction bar, in the order of the card's row.
 * 参加 is left to the card. Where the card has no way to open its messages
 * (onComments), the message count is shown but cannot be pressed.
 */
export function viewerActions({ hasComments = false, showHelp = false } = {}) {
  const actions = [
    { kind: 'comments', label: 'メッセージ', icon: 'message', countKey: 'comment_count', pressable: Boolean(hasComments) },
    { kind: 'like', label: 'いいね', icon: 'heart', countKey: 'like_count', pressable: true },
  ];
  // 手伝えるかも only where the card shows it (see showHelp in recruit-rules.js).
  if (showHelp) actions.push({ kind: 'help', label: '手伝えるかも', icon: 'help', countKey: 'help_count', pressable: true });
  return actions;
}
