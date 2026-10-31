import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../web/js/notice-rules.js', import.meta.url), 'utf8');
const rules = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const NOTICE = { id: 'policy-20261116', text: '11月16日から変わります', url: '/terms/next#changes' };
const base = { notice: NOTICE, signedIn: true, chrome: true };

test('shows on the everyday screens for a signed-in person who has not closed it', () => {
  assert.equal(rules.shouldShowNotice(base), true);
});

test('no notice from the server, no band', () => {
  assert.equal(rules.shouldShowNotice({ ...base, notice: null }), false);
  assert.equal(rules.shouldShowNotice({ ...base, notice: undefined }), false);
  assert.equal(rules.shouldShowNotice({ ...base, notice: { id: 'x', text: '  ', url: '/a' } }), false);
});

test('not while signing up (welcome, sign-in, first profile, guidance) or signed out', () => {
  assert.equal(rules.shouldShowNotice({ ...base, chrome: false }), false);
  assert.equal(rules.shouldShowNotice({ ...base, signedIn: false }), false);
});

test('a closed id stays closed, a new id comes back', () => {
  assert.equal(rules.shouldShowNotice({ ...base, dismissedId: 'policy-20261116' }), false);
  assert.equal(rules.shouldShowNotice({ ...base, closedNow: 'policy-20261116' }), false);
  assert.equal(rules.shouldShowNotice({ ...base, dismissedId: 'policy-20260101' }), true);
});

test('the link has to stay on this site', () => {
  assert.equal(rules.readNotice(NOTICE).url, '/terms/next#changes');
  assert.equal(rules.readNotice({ ...NOTICE, url: 'https://example.com/' }).url, null);
  assert.equal(rules.readNotice({ ...NOTICE, url: '//example.com/' }).url, null);
  assert.equal(rules.readNotice({ ...NOTICE, url: 'javascript:alert(1)' }).url, null);
});

test('remembering the closed id', () => {
  const kept = new Map();
  const storage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v) };
  assert.equal(rules.readDismissed(storage), '');
  assert.equal(rules.writeDismissed(storage, 'policy-20261116'), true);
  assert.equal(rules.readDismissed(storage), 'policy-20261116');
});

test('storage that is missing or throws never breaks the screen', () => {
  const broken = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('full'); },
  };
  assert.equal(rules.readDismissed(broken), '');
  assert.equal(rules.writeDismissed(broken, 'a'), false);
  assert.equal(rules.readDismissed(null), '');
  assert.equal(rules.writeDismissed(null, 'a'), false);
  // Closed this visit only: still hidden because of closedNow.
  assert.equal(rules.shouldShowNotice({ ...base, dismissedId: '', closedNow: NOTICE.id }), false);
});
