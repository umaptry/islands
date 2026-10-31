// The rules behind 「フルネームを教えてください」 (#/fullname), kept free of the page so they can be
// tested in node. No imports on purpose: tests/frontend loads this file on its own.
//
// Who is asked: a person who already has an account, and whose name and 所属 nobody has confirmed yet
// (accounts.name_confirmed_at is empty). Before the date the server says (config.fullname) it is a
// request: it can be closed with 「あとで」 and comes back the next time the app is opened. From that
// date it is required: there is no way past it. The clock is the server's (config.fullname.required),
// never this device's. Age band and job title are not asked here (they are asked of people who apply to a 会).

export const NAME_MAX_DEFAULT = 24;
export const AFFILIATION_MAX = 32;

export const FULLNAME_WORDS = Object.freeze({
  askBadge: (from) => `お願い（${monthDay(from, -1)} まで）`,
  requiredBadge: (from) => `必須（${monthDay(from)} から）`,
  title: 'フルネームを教えてください',
  lede: '11/13 の会から、会場でお互いに誰か分かるように、フルネームで表示します。',
  nameLabel: 'フルネーム',
  affiliationLabel: '会社・所属',
  affiliationPlaceholder: '例：コクヨ株式会社',
  noteAsk: '今のニックネームが入っています。同じコミュニティの人に、この名前が見えます。',
  noteRequired: '同じコミュニティの人に、この名前が見えます。年代や職種は聞きません。',
  save: '保存する',
  later: 'あとで',
  stuck: '入れるまで、先には進めません',
  needName: 'フルネームを入力してください。',
  needAffiliation: '会社・所属を入力してください。',
});

/** "2026-11-16" -> "11/16" (days is added first: -1 gives the day before). '' when it cannot be read. */
export function monthDay(iso, days = 0) {
  const found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!found) return '';
  const moved = new Date(Date.UTC(Number(found[1]), Number(found[2]) - 1, Number(found[3]) + days));
  return `${moved.getUTCMonth() + 1}/${moved.getUTCDate()}`;
}

/**
 * 'required' (cannot go on), 'ask' (a request that can be closed), or 'no'.
 * Nobody without a name is asked here (they are still signing up), and nobody is asked when the server
 * has not said anything (an older server): the screen ships before the switch.
 */
export function needsFullname(cfg, account) {
  const rule = cfg && cfg.fullname;
  if (!rule || typeof rule !== 'object') return 'no';
  if (!account || !String(account.display_name || '').trim()) return 'no';
  if (account.name_confirmed_at) return 'no';
  return rule.required === true ? 'required' : 'ask';
}

/** The name limit (limits.name_max, 24 now). */
export const nameMax = (cfg) => {
  const value = Number(cfg && cfg.limits && cfg.limits.name_max);
  return Number.isInteger(value) && value > 0 ? value : NAME_MAX_DEFAULT;
};

/** { ok, name, affiliation, message } for what was typed. Counts characters, not UTF-16 units. */
export function validateFullname(raw, cfg) {
  const name = String((raw && raw.name) || '').replace(/\s+/g, ' ').trim();
  const affiliation = String((raw && raw.affiliation) || '').replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, name, affiliation, message: FULLNAME_WORDS.needName };
  if (!affiliation) return { ok: false, name, affiliation, message: FULLNAME_WORDS.needAffiliation };
  const max = nameMax(cfg);
  if (Array.from(name).length > max) return { ok: false, name, affiliation, message: `フルネームは${max}字までです。` };
  if (Array.from(affiliation).length > AFFILIATION_MAX) {
    return { ok: false, name, affiliation, message: `会社・所属は${AFFILIATION_MAX}字までです。` };
  }
  return { ok: true, name, affiliation, message: '' };
}
