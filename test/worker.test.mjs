import test from 'node:test';
import assert from 'node:assert/strict';
import { trimValidators, grossRate, buildPrices, callerKey } from '../worker/src/index.js';

const v = (over) => ({ name: 'Pool', address: 'NQ15 HNAH YRVH DFVM YHAG BSXG 0QHK KA0Q XDR7', fee: 0.05, payoutType: 'restake', payoutSchedule: 'Every 12 hours', accentColor: '#c08e2f', dominanceRatio: 0.02, isListed: true, score: { total: 0.99 }, logo: 'data:image/svg+xml;base64,AAAA', ...over });

test('trimValidators keeps restaking pools, sorted, without logos', () => {
  const out = trimValidators([v({ name: 'B', score: { total: 0.9 } }), v({ name: 'A' }), v({ name: 'Direct', payoutType: 'direct' }), v({ name: 'None', payoutType: 'none' }), v({ name: 'Costly', fee: 0.3 }), v({ name: 'Weak', score: { total: 0.2 } }), v({ name: 'Hidden', isListed: false })]);
  assert.deepEqual(out.map((x) => x.name), ['A', 'B']);
  assert.ok(!('logo' in out[0]));
});

test('equally reliable pools sort by fee', () => {
  const out = trimValidators([v({ name: 'Dear', fee: 0.05, score: { total: 0.999 } }), v({ name: 'Cheap', fee: 0.01, score: { total: 0.996 } }), v({ name: 'Shaky', fee: 0, score: { total: 0.8 } })]);
  assert.deepEqual(out.map((x) => x.name), ['Cheap', 'Dear', 'Shaky']);
});

test('trimValidators cleans upstream values', () => {
  const [x] = trimValidators([v({ accentColor: 'red;background:url(x)', payoutSchedule: '0 */6 * * *', name: 'x'.repeat(99) })]);
  assert.equal(x.color, '#1f2348');
  assert.equal(x.schedule, '');
  assert.equal(x.name.length, 32);
  assert.throws(() => trimValidators('nope'));
});

test('grossRate and buildPrices', () => {
  assert.equal(grossRate({ total: 1465110182315820, staking: 940533270769184, max: 2100000000000000 }), 0.0796);
  assert.equal(grossRate({}), null);
  assert.equal(grossRate(null), null);
  const p = buildPrices([{ last: '0.0002' }], { rates: { EUR: 0.9, CRC: 500, GMD: 70 } });
  assert.deepEqual(Object.keys(p).sort(), ['crc', 'eur', 'gmd', 'usd']);
  assert.deepEqual(buildPrices([], null), {});
  assert.deepEqual(buildPrices([{ last: 'x' }], null), {});
  assert.deepEqual(Object.keys(buildPrices([{ last: '0.0002' }], null)), ['usd']);
});

test('callerKey groups an IPv6 /64', () => {
  const req = (ip) => ({ headers: new Headers({ 'cf-connecting-ip': ip }) });
  assert.equal(callerKey(req('2001:db8:1:2:aaaa::1')), callerKey(req('2001:db8:1:2:bbbb::9')));
  assert.notEqual(callerKey(req('2001:db8:1:3::1')), callerKey(req('2001:db8:1:2::1')));
  assert.equal(callerKey(req('2001:db8::1234:5678:9abc:def0')), '2001:db8:0:0');
  assert.equal(callerKey(req('2001:db8::1')), '2001:db8:0:0');
  assert.equal(callerKey(req('203.0.113.7')), '203.0.113.7');
});
