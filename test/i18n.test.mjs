import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dictionaries, t, tn, setLang, pickLang } from '../docs/js/i18n.js';

const src = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const used = new Set();
for (const m of src.matchAll(/\bt\('([a-zA-Z0-9.]+)'/g)) used.add(m[1]);
for (const m of src.matchAll(/\btn\('([a-zA-Z0-9.]+)'/g)) { used.add(`${m[1]}_one`); used.add(`${m[1]}_other`); }

test('every key used by the app exists in every language', () => {
  for (const [code, dict] of Object.entries(dictionaries)) {
    const missing = [...used].filter((k) => !(k in dict));
    assert.deepEqual(missing, [], code);
  }
});

test('all languages share the same keys and placeholders', () => {
  const en = dictionaries.en;
  for (const [code, dict] of Object.entries(dictionaries)) {
    assert.deepEqual(Object.keys(dict).sort(), Object.keys(en).sort(), code);
    for (const key of Object.keys(en)) {
      const vars = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
      assert.equal(vars(dict[key]), vars(en[key]), `${code} ${key}`);
    }
  }
});

test('no key goes unused', () => {
  const unused = Object.keys(dictionaries.en).filter((k) => !used.has(k));
  assert.deepEqual(unused, []);
});

test('honesty: no language calls staked NIM locked or promises a return', () => {
  const banned = /\b(locked|guarantee\w*|lock-?up|risk-?free|bloquead\w*|garantiz\w*|verrouill\w*|bloqué\w*|garanti\w*|imefungwa|kufungwa|uhakika)\b/i;
  for (const [code, dict] of Object.entries(dictionaries)) {
    for (const [key, text] of Object.entries(dict)) assert.ok(!banned.test(text), `${code} ${key}: ${text}`);
  }
});

test('language pick and plural', () => {
  assert.equal(pickLang('es'), 'es');
  assert.equal(pickLang('fr-CA'), 'fr');
  assert.equal(pickLang('de'), 'en');
  assert.equal(pickLang(null), 'en');
  setLang('en');
  assert.equal(tn('goal.streak', 1), '1 week');
  assert.equal(tn('goal.streak', 3), '3 weeks');
  assert.equal(t('goal.of', { saved: '1', target: '2 NIM' }), '1 of 2 NIM');
});
