// Will the server take this text (a post, the answer to a 会's question)? Asked a beat after the person stops
// typing and when they leave the box, so the reason shows under that box and its button waits (2026-11-07,
// the user: told only on 投稿する / 申し込む, people could not tell which box was wrong and could not go on).
// Only a hint: the post and the application are checked again. A failed ask lets the text through.

export const TEXT_CHECK_WAIT_MS = 700;
// An answer slower than this lets the text through, as a failed one does: a button must never hang on it.
export const TEXT_CHECK_LIMIT_MS = 3000;

const answers = new Map();   // text -> { ok, message }, kept for the page's life (the server's rules do not move)

/** One box's checking. ask(text) -> Promise<{ ok, message }> (POST /api/text-check). onChange gets
 * { status, message }: 'idle' (nothing to check), 'typing', 'checking', 'ok' or 'ng'. An 'ng' stays until
 * the next answer, so the button does not come back between two keys. */
export function textCheck({ ask, onChange = () => {}, wait = TEXT_CHECK_WAIT_MS, limit = TEXT_CHECK_LIMIT_MS, timers = globalThis } = {}) {
  let current = '';
  let timer = 0;
  let shown = { status: 'idle', message: '' };
  const set = (next) => {
    if (next.status === shown.status && next.message === shown.message) return;
    shown = next;
    onChange(next);
  };
  const look = (text) => {
    if (!answers.has(text)) {
      let clock = 0;
      const late = new Promise((_resolve, reject) => { clock = timers.setTimeout(() => reject(new Error('slow')), limit); });
      answers.set(text, Promise.race([Promise.resolve().then(() => ask(text)), late]).then(
        (result) => (result && result.ok === false ? { ok: false, message: String(result.message || '') } : { ok: true, message: '' }),
        () => { answers.delete(text); return { ok: true, message: '' }; },
      ).finally(() => timers.clearTimeout(clock)));
    }
    return answers.get(text);
  };

  /** Check now (leaving the box, or the button pressed): the answer for this text. */
  function settle(raw) {
    timers.clearTimeout(timer);
    const text = String(raw || '').trim();
    current = text;
    if (!text) {
      set({ status: 'idle', message: '' });
      return Promise.resolve({ ok: true, message: '' });
    }
    if (shown.status !== 'ng') set({ status: 'checking', message: '' });
    return look(text).then((result) => {
      if (current === text) set({ status: result.ok ? 'ok' : 'ng', message: result.message });
      return result;
    });
  }

  /** The text changed: check it once the typing stops. */
  function typed(raw) {
    timers.clearTimeout(timer);
    const text = String(raw || '').trim();
    current = text;
    if (!text) { set({ status: 'idle', message: '' }); return; }
    if (shown.status !== 'ng') set({ status: 'typing', message: '' });
    timer = timers.setTimeout(() => { settle(text); }, wait);
  }

  return {
    typed,
    settle,
    get state() { return shown; },
    /** The screen went away: a late answer changes nothing. */
    stop() { timers.clearTimeout(timer); current = null; },
  };
}
