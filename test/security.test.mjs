// Fixes from the security read of v3: link-like names and notes, the braille blank, names that say nothing, and the
// stored state for Lightning tries and stake sums.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as J from '../docs/js/jar.js';
import * as G from '../docs/js/goals.js';
import { utf8Bytes } from '../docs/js/nim.js';

const OWNER = 'NQ32 9CGX GGYH 2DNL D7AL AQGM FHU8 SJ5U 8DKM';
const GOAL = { id: '64ru59', name: 'Emergency fund', target: 50000e5, date: null, owner: OWNER, net: 'mainnet' };
const hex = (s) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');

test('a goal name that reads like a web address never travels in an invite', () => {
  for (const name of ['Free NIM at evil.example', 'www.x.io', 'see https://a', 'claim-now.top fund', 'kuza.app']) {
    assert.equal(J.cleanName(name), '', name);
    assert.equal(J.decodeInvite(J.encodeInvite({ ...GOAL, name })), null, name);
    assert.equal(J.decodeJar(J.encodeJar({ ...GOAL, name })), null, name);
  }
  for (const name of ['Emergency fund', 'Ada ya shule', 'Trip to St. Lucia', 'Ph.D fees', '学费 2027', 'iPhone 17']) {
    assert.equal(J.cleanName(name), name, name);
    assert.equal(J.decodeInvite(J.encodeInvite({ ...GOAL, name })).name, name);
  }
});

test('names need a letter or a digit; blank look-alikes go, the braille blank too', () => {
  assert.equal(J.cleanText('a⠀b', 40), 'a b');
  assert.equal(J.cleanName('⠀⠀'), '');
  assert.equal(J.cleanName('!!! ---'), '');
  assert.equal(J.cleanName('🎓🎓'), '');
  assert.equal(J.decodeInvite(J.encodeInvite({ ...GOAL, name: '⠀ㅤ' })), null);
  assert.equal(J.decodeInvite(J.encodeInvite({ ...GOAL, name: '...' })), null);
});

test('a gift note that reads like a link is dropped; the gift still counts', () => {
  const memo = J.buildMemo('64ru59', 'claim at evil.example');
  assert.ok(utf8Bytes(memo) <= 64);
  assert.deepEqual(J.parseMemo(hex(memo)), { id: '64ru59', note: '' });
  assert.deepEqual(J.parseMemo(hex(J.buildMemo('64ru59', 'Happy birthday!'))), { id: '64ru59', note: 'Happy birthday!' });
  const tx = { hash: 'a'.repeat(64), from: 'NQ80 UUAS BU0Q 6Q5B 17C7 E245 DNST 92Q1 65NG', to: OWNER, value: 5e5, recipientData: hex(memo), executionResult: true, timestamp: 1 };
  const gifts = J.giftsFromHistory([tx], OWNER, '64ru59');
  assert.equal(gifts.length, 1);
  assert.equal(gifts[0].note, '');
});

test('stored state: Lightning tries are 64-hex only, last 50; stake sums are whole, non-negative numbers', () => {
  const good = 'ab'.repeat(32);
  const tries = [...Array(60)].map((_, i) => i.toString(16).padStart(64, '0'));
  // Junk last, so the "last 50" cut can't hide a filter that lets it through.
  const st = G.sanitizeState({ v: 1, lnTried: [...tries, 'x', good.toUpperCase(), 42, `${good}0`, good], stakeCache: { [OWNER]: { deposits: 5, withdrawals: 0, doubtful: 0, count: 1 }, bad: { deposits: -1, withdrawals: 0, doubtful: 0, count: 0 }, worse: 'x' } });
  assert.equal(st.lnTried.length, 50);
  assert.ok(st.lnTried.every((x) => /^[0-9a-f]{64}$/.test(x)));
  assert.equal(st.lnTried[49], good);
  assert.equal(st.lnTried[48], tries[59]);
  assert.deepEqual(st.stakeCache, { [OWNER]: { deposits: 5, withdrawals: 0, doubtful: 0, count: 1 } });
  assert.deepEqual(G.sanitizeState({ v: 1, stakeCache: [1, 2], lnTried: 'x' }).stakeCache, {});
  assert.deepEqual(G.sanitizeState({ v: 1 }).lnTried, []);
});

// From the second security read: 27 ways past the first filter, all refused, and real names that must still pass.
const BYPASS = ['t.me/nimiqhelp', 'x.com/nimiq_support', 'nimiq-gift．com', 'nimiq-gift。com', 'nimiqgift｡com', 'ｗｗｗ．ｅｖｉｌ．ｃｏｍ',
  'evil͏.com', 'evil️.com', 'evil᠋.com', 'evil឴.com', 'evil\u{E0100}.com', 'https:͏//evil', 'evịl.com',
  '203.0.113.5/claim', 'nimiq.рф', 'ехаmрlе.соm', 'пример.com', 'a_b.com', 'DM @nimiq_help', 'Send to NQ07 0000 0000 0000',
  'Free NIM at evil.example', 'www.x.io', 'see https://a', 'claim-now.top fund', 'kuza.app', 'xn--80ak6aa92e.com', 'evil.com'];
const LEGIT = ['Emergency fund', 'Ada ya shule', 'Trip to St. Lucia', 'Ph.D fees', '学费 2027', 'iPhone 17', 'Happy birthday!',
  'Good luck with the fund', "Mama's 60th", 'Laptop', 'Nyumba ya mama', 'Viaje a México', 'Café & croissants', 'Rent: Dec.',
  'v1.0 savings', 'Mom @ home', 'हिन्दी बचत', 'ประหยัด', 'Études', 'Café au lait'];

test('27 known bypasses: refused as a goal name, in both link formats, and dropped as a gift note', () => {
  assert.equal(BYPASS.length, 27);
  for (const b of BYPASS) {
    assert.ok(J.linkish(b), `linkish ${JSON.stringify(b)}`);
    assert.equal(J.cleanName(b), '', `name ${JSON.stringify(b)}`);
    assert.equal(J.decodeInvite(J.encodeInvite({ ...GOAL, name: b })), null, `invite ${JSON.stringify(b)}`);
    assert.equal(J.decodeJar(J.encodeJar({ ...GOAL, name: b })), null, `jar ${JSON.stringify(b)}`);
    assert.equal(J.parseMemo(hex(J.buildMemo('64ru59', b))).note, '', `note ${JSON.stringify(b)}`);
  }
});

test('emoji-label domains are refused too; emoji in ordinary names are fine', () => {
  for (const b of ['i\u2764.ws', 'evil\u{1F642}.com', 'evil\u2764\uFE0F.com', '\u{1F355}.ws']) {
    assert.ok(J.linkish(b), JSON.stringify(b));
    assert.equal(J.cleanName(b), '', JSON.stringify(b));
    assert.equal(J.parseMemo(hex(J.buildMemo('64ru59', b))).note, '', JSON.stringify(b));
  }
  for (const name of ['Trip \u{1F334}', '\u{1F393} fees 2027', 'Bike \u{1F6B2}. New one', 'Gift for Mama \u2764']) {
    assert.ok(!J.linkish(name), JSON.stringify(name));
    assert.equal(J.cleanName(name), name);
  }
});

test('real names in the app\'s languages pass untouched (the check folds a copy, never the name)', () => {
  for (const name of LEGIT) {
    assert.ok(!J.linkish(name), `false positive ${JSON.stringify(name)}`);
    assert.equal(J.cleanName(name), name, name);
    assert.equal(J.decodeInvite(J.encodeInvite({ ...GOAL, name })).name, name);
  }
  // Invisible marks are removed, not turned into a gap that hides a dot.
  assert.equal(J.cleanText('evil͏.com', 40), 'evil.com');
  assert.equal(J.cleanName('ㅤ'), '');
});

test('switching accounts keeps every Lightning invoice already handed to the wallet', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const prev = G.sanitizeState({ v: 1, address: OWNER, lang: 'sw', noCount: true, lnTried: [a] });
  const next = G.sanitizeState({ v: 1, address: 'NQ43 MS6V QJLN 7GXB VSUA GHLK UVB5 YJ9K D4B5', lnTried: [b], goals: [] });
  const out = G.carryOver(prev, next);
  assert.deepEqual(out.lnTried.sort(), [a, b]);
  assert.equal(out.lang, 'sw');
  assert.equal(out.noCount, true);
  assert.equal(out.address, next.address);
  assert.deepEqual(G.carryOver(prev, G.sanitizeState(null)).lnTried, [a]);
});

test('the site keeps forbidding framing', async () => {
  const { readFileSync } = await import('node:fs');
  const headers = readFileSync(new URL('../docs/_headers', import.meta.url), 'utf8');
  assert.match(headers, /^\/\*$/m);
  assert.match(headers, /^\s+X-Frame-Options:\s*DENY\s*$/m);
  assert.match(headers, /^\s+Content-Security-Policy:\s*frame-ancestors 'none'\s*$/m);
});
