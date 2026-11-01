import test from 'node:test';
import assert from 'node:assert/strict';
import { toLuna, fmtNim, normalizeAddress, shortAddress, cutBytes, hexToText, fmtFiat } from '../docs/js/nim.js';
import * as S from '../docs/js/staking.js';
import * as J from '../docs/js/jar.js';
import * as G from '../docs/js/goals.js';

const ADDR = 'NQ15 HNAH YRVH DFVM YHAG BSXG 0QHK KA0Q XDR7';
const OWNER = 'NQ43 Y1RH P1K7 JH78 LRTS 95RY GAUU UBDK FFGX';
const NOW = Date.UTC(2026, 10, 1, 12);
const WEEK = 7 * 864e5;
const NIM = 100000;

test('toLuna parses amounts exactly and refuses junk', () => {
  assert.equal(toLuna('1'), 100000);
  assert.equal(toLuna('1.5'), 150000);
  assert.equal(toLuna('1,5'), 150000);
  assert.equal(toLuna('.00001'), 1);
  assert.equal(toLuna(' 2500 '), 250000000);
  for (const bad of ['', 'abc', '-1', '1e5', '1.000001', '1..2', '0x10', '99999999999999999', '1.2.3', null, undefined, {}]) {
    assert.equal(toLuna(bad), null, String(bad));
  }
  assert.equal(toLuna('21000000000'), 21e14);
  assert.equal(toLuna('21000000001'), null);
});

test('fmtNim and fmtFiat', () => {
  assert.equal(fmtNim(123456789, 'en'), '1,235');
  assert.equal(fmtNim(150000, 'en'), '1.5');
  assert.equal(fmtFiat(100000000, 0.00026, 'USD', 'en'), '$0.26');
  assert.equal(fmtFiat(1, 0, 'USD', 'en'), '');
  assert.equal(fmtFiat(1, 1, 'XX', 'en'), '');
});

test('addresses: real ones pass, tampered ones fail', () => {
  assert.equal(normalizeAddress(ADDR), ADDR);
  assert.equal(normalizeAddress(ADDR.replace(/ /g, '').toLowerCase()), ADDR);
  assert.equal(normalizeAddress('NQ81 C01N BASE 0000 0000 0000 0000 0000 0000'), 'NQ81 C01N BASE 0000 0000 0000 0000 0000 0000');
  assert.equal(normalizeAddress(S.STAKING_CONTRACT), S.STAKING_CONTRACT);
  assert.equal(normalizeAddress(ADDR.replace('XDR7', 'XDR8')), null);
  assert.equal(normalizeAddress('NQ15 HNAH'), null);
  assert.equal(normalizeAddress('NQ15 HNAH YRVH DFVM YHAG BSXG 0QHK KA0Q XDRI'), null);
  assert.equal(normalizeAddress(42), null);
  assert.equal(shortAddress(ADDR), 'NQ15 HNAH … XDR7');
});

test('election and release match real chain data', () => {
  // getElectionBlockAfter(65760000) answered 65793600 on mainnet.
  assert.equal(S.electionBlockAfter(65760000), 65793600);
  // An election block itself rolls to the next one.
  assert.equal(S.electionBlockAfter(65793600), 65793600 + 43200);
  // Real staker: set-active at 61651396, retired at 61738190. Must not be before the computed release.
  const release = S.releaseIfStartedAt(61651396);
  assert.equal(release, 61689600 + 43201);
  assert.ok(release <= 61738190);
  // Always between one and two epochs.
  for (let h = 65760000; h < 65760000 + 90000; h += 777) {
    const wait = S.releaseIfStartedAt(h) - h;
    assert.ok(wait > 43200 && wait <= 86401, String(wait));
  }
});

test('saveRoute enforces the 100 NIM floor the way the contract does', () => {
  assert.equal(S.saveRoute(150 * NIM, null).route, 'new');
  assert.equal(S.saveRoute(100 * NIM, null).route, 'new');
  const low = S.saveRoute(99 * NIM, null);
  assert.equal(low.route, 'aside');
  assert.equal(low.short, NIM);
  const staker = S.normalizeStaker({ balance: 150 * NIM, inactiveBalance: 0, retiredBalance: 0 });
  assert.equal(S.saveRoute(1, staker).route, 'add');
  const retiredOnly = S.normalizeStaker({ balance: 0, inactiveBalance: 0, retiredBalance: 150 * NIM });
  assert.equal(S.saveRoute(50 * NIM, retiredOnly).route, 'aside');
  assert.equal(S.saveRoute(100 * NIM, retiredOnly).route, 'add');
  assert.equal(S.saveRoute(0, null).route, 'invalid');
  assert.equal(S.saveRoute(1.5, null).route, 'invalid');
});

test('withdrawStage walks the real path', () => {
  const h = 1000000;
  assert.equal(S.withdrawStage(null, h).stage, 'none');
  assert.equal(S.withdrawStage(S.normalizeStaker({ balance: 5 }), h).stage, 'active');
  const cooling = S.normalizeStaker({ balance: 0, inactiveBalance: 5, inactiveFrom: h });
  const s = S.withdrawStage(cooling, h);
  assert.equal(s.stage, 'cooling');
  assert.equal(s.blocksLeft, 43201);
  assert.equal(S.withdrawStage(cooling, h + 43201).stage, 'retire');
  // A jailed validator pushes it out.
  assert.equal(S.withdrawStage(cooling, h + 43201, h + 100000).stage, 'cooling');
  assert.equal(S.withdrawStage(S.normalizeStaker({ balance: 5, retiredBalance: 7 }), h).stage, 'remove');
});

test('checkWithdraw refuses to leave dust under 100 NIM', () => {
  const st = S.normalizeStaker({ balance: 250 * NIM });
  assert.ok(S.checkWithdraw(250 * NIM, st).ok);
  assert.ok(S.checkWithdraw(150 * NIM, st).ok);
  const dust = S.checkWithdraw(200 * NIM, st);
  assert.equal(dust.reason, 'dust');
  assert.equal(dust.max, 150 * NIM);
  assert.equal(S.checkWithdraw(300 * NIM, st).reason, 'too_much');
  assert.equal(S.checkWithdraw(0, st).reason, 'invalid');
});

test('retirePlan copes with a late reward landing in active stake', () => {
  const st = (active, inactive) => S.normalizeStaker({ balance: active, inactiveBalance: inactive, inactiveFrom: 1 });
  assert.deepEqual(S.retirePlan(st(0, 500 * NIM)), { amount: 500 * NIM, leaves: 0 });
  assert.deepEqual(S.retirePlan(st(200 * NIM, 50 * NIM)), { amount: 50 * NIM, leaves: 0 });
  // A 2 NIM reward arrived: 98 NIM must stay inactive so active + inactive stays at 100.
  assert.deepEqual(S.retirePlan(st(2 * NIM, 500 * NIM)), { amount: 402 * NIM, leaves: 98 * NIM });
  assert.equal(S.retirePlan(st(2 * NIM, 90 * NIM)).amount, 0);
  assert.equal(S.retirePlan(null).amount, 0);
});

test('gross rate estimate lands near what a real staker earned', () => {
  const rate = S.estimateGrossRate(1465110182315820, 940533270769184);
  assert.ok(rate > 0.06 && rate < 0.1, String(rate));
  assert.equal(S.estimateGrossRate(0, 1), null);
  assert.equal(S.estimateGrossRate(21e14, 1), null);
});

test('jar link round trip and hostile input', () => {
  const p = J.encodeJar({ id: 'ab23cd', name: 'Moto para Ana 🛵', target: 500000 * NIM, date: '2027-03-01', owner: ADDR, net: 'mainnet' });
  const j = J.decodeJar(p);
  assert.equal(j.name, 'Moto para Ana 🛵');
  assert.equal(j.owner, ADDR);
  assert.equal(j.target, 500000 * NIM);
  assert.equal(j.net, 'mainnet');
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const good = { v: 1, i: 'ab23cd', n: 'x', t: 5, d: null, a: ADDR.replace(/ /g, ''), e: 'm' };
  assert.ok(J.decodeJar(enc(good)));
  for (const bad of [
    { ...good, v: 2 }, { ...good, a: 'NQ00' }, { ...good, t: -1 }, { ...good, t: 1.5 }, { ...good, t: 3e15 },
    { ...good, i: '../../x' }, { ...good, n: '' }, { ...good, d: '<script>' }, { ...good, e: 'x' }, null, [], 7,
  ]) assert.equal(J.decodeJar(enc(bad)), null, JSON.stringify(bad));
  for (const bad of ['', '!!!', 'a'.repeat(513), undefined, 5, '%%%']) assert.equal(J.decodeJar(bad), null);
  assert.equal(J.decodeJar(enc({ ...good, n: 'a‮b\u0000c' })).name, 'a b c');
});

test('memo fits 64 bytes, with multibyte text too', () => {
  const m = J.buildMemo('ab23cd', 'é'.repeat(100));
  assert.ok(Buffer.byteLength(m) <= 64);
  assert.ok(m.startsWith('KZ1|ab23cd|'));
  assert.ok(!J.buildMemo('ab23cd', 'a|b').slice(11).includes('|'));
  const hex = Buffer.from(J.buildMemo('ab23cd', 'Feliz cumple')).toString('hex');
  assert.deepEqual(J.parseMemo(hex), { id: 'ab23cd', note: 'Feliz cumple' });
  assert.equal(J.parseMemo('zz'), null);
  assert.equal(J.parseMemo(Buffer.from('hello').toString('hex')), null);
});

test('gifts: only real transfers to the owner, each once', () => {
  const memo = Buffer.from('KZ1|ab23cd|hi').toString('hex');
  const tx = { hash: 'h1', to: OWNER, from: ADDR, value: 500, recipientData: memo, executionResult: true, timestamp: 5, blockNumber: 1 };
  const out = J.giftsFromHistory([tx, tx, { ...tx, hash: 'h2', executionResult: false }, { ...tx, hash: 'h3', to: ADDR }, { ...tx, hash: 'h4', recipientData: '' }, { ...tx, hash: 'h5', value: 0 }], OWNER, 'ab23cd');
  assert.equal(out.length, 1);
  assert.equal(out[0].note, 'hi');
  assert.equal(J.giftsFromHistory([tx], OWNER, 'zzzzzz').length, 0);
});

function goal(entries = [], extra = {}) {
  return { ...G.newGoal({ id: 'ab23cd', name: 'x', target: 1000 * NIM, date: '2026-12-31', weekly: 50 * NIM, now: NOW }), entries, ...extra };
}
const ok = (kind, luna, at, more = {}) => ({ kind, luna, at, status: 'ok', ...more });

test('parts: aside, gift, stake and withdraw add up; pending and failed do not count', () => {
  const g = goal([
    ok('aside', 40 * NIM, NOW),
    ok('gift', 60 * NIM, NOW),
    ok('stake', 150 * NIM, NOW, { fromWallet: 100 * NIM }),
    ok('withdraw', 20 * NIM, NOW),
    { kind: 'stake', luna: 999 * NIM, at: NOW, status: 'pending' },
    { kind: 'stake', luna: 999 * NIM, at: NOW, status: 'failed' },
  ]);
  assert.deepEqual(G.parts(g), { stake: 130 * NIM, wallet: 0, gifts: 60 * NIM });
});

test('earned is what the staker has beyond the baseline and deposits', () => {
  const g = goal([ok('stake', 150 * NIM, NOW)]);
  assert.equal(G.earnedTotal(152 * NIM, 0, [g]), 2 * NIM);
  assert.equal(G.earnedTotal(1152 * NIM, 1000 * NIM, [g]), 2 * NIM);
  assert.equal(G.earnedTotal(100 * NIM, 0, [g]), 0);
  const settling = goal([ok('stake', 150 * NIM, NOW), { kind: 'stake', luna: 50 * NIM, at: NOW, status: 'pending' }]);
  assert.equal(G.earnedTotal(201 * NIM, 0, [settling]), NIM);
  const h = goal([ok('stake', 50 * NIM, NOW)], { id: 'zz23zz' });
  assert.equal(G.earnedShare(g, [g, h], 4 * NIM), 3 * NIM);
  assert.equal(G.earnedShare(h, [g, h], 4 * NIM), 1 * NIM);
});

test('streak and weekly reminder', () => {
  const g = goal([
    ok('stake', 50 * NIM, NOW + 1000),
    ok('stake', 50 * NIM, NOW + WEEK + 1000),
    ok('stake', 50 * NIM, NOW + 2 * WEEK + 1000),
  ]);
  assert.equal(G.streak(g, NOW + 2 * WEEK + 2000), 3);
  // A new week with nothing saved yet does not break it.
  assert.equal(G.streak(g, NOW + 3 * WEEK + 2000), 3);
  // A whole missed week does.
  assert.equal(G.streak(g, NOW + 4 * WEEK + 2000), 0);
  assert.equal(G.dueNow(g, NOW + 2 * WEEK + 2000), null);
  const due = G.dueNow(g, NOW + 3 * WEEK + 2000);
  assert.equal(due.left, 50 * NIM);
  assert.equal(due.endsAt, NOW + 4 * WEEK);
  assert.equal(G.dueNow(goal([], { weekly: 0 }), NOW), null);
  assert.equal(G.weekStrip(g, NOW + 3 * WEEK, 8).length, 4);
});

test('moving wallet money into stake is not counted as new saving', () => {
  const g = goal([ok('aside', 60 * NIM, NOW + 1000), ok('stake', 60 * NIM, NOW + 2000, { fromWallet: 60 * NIM })]);
  assert.equal(G.weekStrip(g, NOW + 3000, 1)[0].amount, 60 * NIM);
});

test('suggestWeekly and onTrack', () => {
  assert.equal(G.weeksUntil('2026-11-08', NOW), 2);
  assert.equal(G.weeksUntil('2020-01-01', NOW), 0);
  assert.equal(G.suggestWeekly(70 * NIM, '2026-11-08', NOW), 35 * NIM);
  assert.equal(G.suggestWeekly(70 * NIM, null, NOW), 0);
  const g = goal();
  const end = Date.parse('2026-12-31T23:59:59Z');
  const t = G.onTrack(g, 500 * NIM, (NOW + end) / 2);
  assert.ok(t.ok);
  assert.equal(G.onTrack(goal([], { date: null }), 0, NOW), null);
});

test('mergeGifts only adds new gifts to known goals', () => {
  const g = goal();
  const gift = { hash: 'h1', goal: 'ab23cd', luna: 5, from: ADDR, note: 'x', at: 1 };
  assert.equal(G.mergeGifts([g], [gift, gift, { ...gift, hash: 'h2', goal: 'nope22' }]), 1);
  assert.equal(G.mergeGifts([g], [gift]), 0);
  assert.equal(G.parts(g).gifts, 5);
});

test('sanitizeState drops broken data', () => {
  const s = G.sanitizeState({ v: 1, address: 'x', goals: [{ id: 1 }, null, { id: 'a', name: 'n', target: 5, entries: [{ kind: 'x', luna: 'no' }, { kind: 'aside', luna: 3 }] }] });
  assert.equal(s.goals.length, 1);
  assert.equal(s.goals[0].entries.length, 1);
  assert.deepEqual(G.sanitizeState('junk').goals, []);
  assert.deepEqual(G.sanitizeState({ v: 9 }).goals, []);
});
