import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../web/js/fullname-rules.js', import.meta.url), 'utf8');
const rules = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const ask = { fullname: { required: false, from: '2026-11-16' }, limits: { name_max: 24 } };
const must = { fullname: { required: true, from: '2026-11-16' }, limits: { name_max: 24 } };
const named = { display_name: 'みずき', affiliation: 'コクヨ', name_confirmed_at: null };

test('フルネームを聞く人：名前があって、まだ確かめていない人だけ。日付はサーバーが決める', () => {
  assert.equal(rules.needsFullname(ask, named), 'ask');
  assert.equal(rules.needsFullname(must, named), 'required');
  assert.equal(rules.needsFullname(must, { ...named, name_confirmed_at: '2026-11-02T00:00:00Z' }), 'no');
  assert.equal(rules.needsFullname(must, { display_name: '', name_confirmed_at: null }), 'no', '名前がない人は登録の途中');
  assert.equal(rules.needsFullname(must, null), 'no');
});

test('古いサーバー（fullname を返さない）では、だれにも聞かない', () => {
  assert.equal(rules.needsFullname({}, named), 'no');
  assert.equal(rules.needsFullname(null, named), 'no');
  assert.equal(rules.needsFullname({ fullname: null }, named), 'no');
});

test('名前の上限は limits.name_max（24）。文字数で数える', () => {
  assert.equal(rules.nameMax(ask), 24);
  assert.equal(rules.nameMax({}), 24, '知らされなければ 24');
  assert.equal(rules.validateFullname({ name: 'あ'.repeat(24), affiliation: 'コクヨ' }, ask).ok, true);
  const over = rules.validateFullname({ name: 'あ'.repeat(25), affiliation: 'コクヨ' }, ask);
  assert.equal(over.ok, false);
  assert.match(over.message, /24字/);
  // 「𠮷」のような1文字が2つ分に数えられない
  assert.equal(rules.validateFullname({ name: '𠮷'.repeat(24), affiliation: 'コクヨ' }, ask).ok, true);
});

test('名前も所属も要る。前後の空白は取る', () => {
  assert.equal(rules.validateFullname({ name: '  ', affiliation: 'コクヨ' }, ask).ok, false);
  assert.equal(rules.validateFullname({ name: '山田 瑞希', affiliation: '' }, ask).ok, false);
  const good = rules.validateFullname({ name: ' 山田  瑞希 ', affiliation: ' コクヨ株式会社 ' }, ask);
  assert.deepEqual([good.ok, good.name, good.affiliation], [true, '山田 瑞希', 'コクヨ株式会社']);
});

test('札の日付：お願いは前の日まで、必須は日付から', () => {
  assert.equal(rules.FULLNAME_WORDS.askBadge('2026-11-16'), 'お願い（11/15 まで）');
  assert.equal(rules.FULLNAME_WORDS.requiredBadge('2026-11-16'), '必須（11/16 から）');
  assert.equal(rules.monthDay('2026-12-01', -1), '11/30', '月をまたぐ');
  assert.equal(rules.monthDay('おかしい'), '');
});
