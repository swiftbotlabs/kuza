// Fixes after the iPhone test (8 Nov 2026). Each test fails on the code from before the fix.
// P: one calculation for the plan (badge, pace line, suggestion, form). T: taking some NIM out without deleting the goal.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../docs/js/goals.js';

const NIM = 100000;
const DAY = 864e5;
const WEEK = 7 * DAY;
const START = Date.UTC(2026, 10, 8, 14, 30);
const ok = (kind, luna, at, more = {}) => ({ kind, luna, at, status: 'ok', ...more });
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
// The tester's size: 10,000,000 NIM, date 20 weeks and 3 days away, plan taken from the suggestion.
const big = () => {
  const date = day(START + 20 * WEEK + 3 * DAY);
  const sug = G.suggestPlan(10_000_000 * NIM, date, START);
  return G.newGoal({ id: 'hhhhhh', name: 'House', target: 10_000_000 * NIM, date, weekly: sug.amount, now: START });
};

test('P1: a goal made today with nothing saved is never behind, until its first period has ended', () => {
  const g = big();
  for (const dt of [0, 60e3, 93e3, DAY, WEEK - 1]) {
    assert.equal(G.pace(g, 0, START + dt).status, null, `at +${dt} ms`);
    assert.equal(G.onTrack(g, 0, START + dt), null);
    assert.equal(G.planStatus(g, 0, START + dt), null);
  }
  const plain = G.newGoal({ id: 'pppppp', name: 'P', target: 1000 * NIM, weekly: 100 * NIM, now: START });
  assert.equal(G.pace(plain, 0, START + 3600e3).status, null);
  // One week over, nothing saved: one week's saving is owed.
  const st = G.pace(g, 0, START + WEEK + 1).status;
  assert.equal(st.expected, 476_191 * NIM);
  assert.equal(st.ok, false);
});

test('P2: no drift: within a period the badge reads the same at every moment, on every screen', () => {
  const g = big();
  const a = G.pace(g, 0, START + WEEK + 60e3).status;
  const b = G.pace(g, 0, START + WEEK + 93e3).status;
  const c = G.pace(g, 0, START + 2 * WEEK - 1).status;
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.deepEqual(G.onTrack(g, 0, START + WEEK + 60e3), G.planStatus(g, 0, START + WEEK + 93e3));
});

test('P3: the plan and the suggestion are the same whole number, and a plan made from it is not late', () => {
  const g = big();
  assert.deepEqual(G.suggestPlan(g.target, g.date, START), { amount: 476_191 * NIM, periods: 21 });
  assert.equal(g.weekly % NIM, 0);
  for (const dt of [60e3, DAY, 6 * DAY]) {
    const p = G.pace(g, 0, START + dt);
    assert.equal(p.late, false, `late at +${dt}`);
    assert.equal(p.suggest.amount, g.weekly);
    assert.ok(p.finish.at <= Date.parse(`${g.date}T23:59:59Z`));
  }
});

test('P4: the last period before the date ends on the date', () => {
  const g = big();
  const end = Date.parse(`${g.date}T23:59:59Z`);
  assert.equal(G.periodsToDate(g), 21);
  assert.equal(G.periodEnd(g, 20), end);
  assert.equal(G.periodEnd(g, 19), G.periodStart(g, 20));
  assert.equal(G.nextSave(g, START + 20 * WEEK + DAY).by, end);
  assert.equal(G.pace(g, 0, START).finish.at, end);
});

test('P5: after a missed week the suggestion is what is left over the weeks left, and it says late', () => {
  const g = big();
  const p = G.pace(g, 0, START + WEEK + DAY);
  assert.deepEqual(p.suggest, { amount: 500_000 * NIM, periods: 20 });
  assert.equal(p.late, true);
  assert.ok(p.finish.at > Date.parse(`${g.date}T23:59:59Z`));
  // The goal form, asked about the same goal, gives the same number.
  assert.deepEqual(G.pace({ ...g }, 0, START + WEEK + DAY).suggest, p.suggest);
});

test('P6: amounts compared in whole NIM: under half a NIM short is not "behind"', () => {
  const g = G.newGoal({ id: 'wwwwww', name: 'W', target: 1000 * NIM, weekly: 100 * NIM, now: START });
  assert.equal(G.pace(g, 100 * NIM - 40000, START + WEEK + 1).status.ok, true);
  assert.equal(G.pace(g, 100 * NIM - 60000, START + WEEK + 1).status.ok, false);
});

test('P7: saved this period counts toward this period, not the ones after', () => {
  const g = G.newGoal({ id: 'tttttt', name: 'T', target: 1000 * NIM, date: day(START + 10 * WEEK), weekly: 100 * NIM, now: START }); // 10 weeks
  assert.equal(G.pace(g, 0, START + DAY).suggest.amount, 100 * NIM);
  g.entries.push(ok('aside', 100 * NIM, START + DAY));
  assert.equal(G.pace(g, 100 * NIM, START + 2 * DAY).suggest.amount, 100 * NIM);
  assert.equal(G.pace(g, 100 * NIM, START + 2 * DAY).late, false);
});

test('T1: taking some out of what the goal holds in the wallet keeps the goal and the rest', () => {
  const g = G.newGoal({ id: 'ssssss', name: 'School fees', target: 1000 * NIM, weekly: 60 * NIM, now: START });
  g.entries.push(ok('aside', 60 * NIM, START + 1000));
  const e = G.takeOutEntry(g, 20 * NIM, START + 2000);
  assert.deepEqual(e, { kind: 'out', luna: 20 * NIM, at: START + 2000, status: 'ok' });
  g.entries.push(e);
  assert.deepEqual(G.parts(g), { stake: 0, wallet: 40 * NIM, gifts: 0 });
  assert.equal(G.progress(g).saved, 40 * NIM);
  assert.equal(G.takeOutEntry(g, 500 * NIM, START).luna, 40 * NIM); // never more than it holds
  assert.equal(G.takeOutEntry(g, 0, START), null);
  assert.equal(G.takeOutEntry(g, -5, START), null);
  // A later gift is not swallowed by an earlier take-out.
  g.entries.push(ok('out', 40 * NIM, START + 3000), ok('gift', 15 * NIM, START + 4000));
  assert.equal(G.parts(g).wallet, 15 * NIM);
});

test('T2: a take-out is not saving: the week is not met and the streak does not count it', () => {
  const g = G.newGoal({ id: 'ssssss', name: 'School fees', target: 1000 * NIM, weekly: 60 * NIM, now: START });
  g.entries.push(ok('aside', 60 * NIM, START + 1000));
  assert.equal(G.streak(g, START + 2000), 1);
  g.entries.push(ok('out', 20 * NIM, START + 2000));
  assert.equal(G.streak(g, START + 3000), 0);
  assert.equal(G.dueNow(g, START + 3000).left, 20 * NIM);
  assert.equal(G.weekStrip(g, START + 3000, 1)[0].amount, 40 * NIM);
  // Taken out in a later week: last week stays met; this week reads 0, never below.
  const h = G.newGoal({ id: 'hhhhhh', name: 'H', target: 1000 * NIM, weekly: 60 * NIM, now: START });
  h.entries.push(ok('aside', 60 * NIM, START + 1000), ok('out', 30 * NIM, START + WEEK + 1000));
  assert.equal(G.streak(h, START + WEEK + 2000), 1);
  assert.equal(G.weekStrip(h, START + WEEK + 2000, 2)[1].amount, 0);
});

test('T3: the take-out plan: the wallet part first, then the stake, never more than the goal holds', () => {
  const g = G.newGoal({ id: 'mmmmmm', name: 'M', target: 1000 * NIM, now: START });
  g.entries.push(ok('aside', 40 * NIM, START), ok('stake', 300 * NIM, START + 1));
  assert.deepEqual(G.takeOutPlan(g, 20 * NIM, 300 * NIM), { now: 20 * NIM, fromStake: 0 });
  assert.deepEqual(G.takeOutPlan(g, 200 * NIM, 300 * NIM), { now: 40 * NIM, fromStake: 160 * NIM });
  assert.deepEqual(G.takeOutPlan(g, 500 * NIM, 300 * NIM), { now: 40 * NIM, fromStake: 300 * NIM }); // 340 < 500: the app refuses
});

test('T4: staked NIM taken out comes off the goal only once it is back in the wallet', () => {
  const g = G.newGoal({ id: 'kkkkkk', name: 'K', target: 1000 * NIM, now: START });
  g.entries.push(ok('aside', 40 * NIM, START), ok('stake', 300 * NIM, START + 1));
  g.entries.push(G.takeOutEntry(g, 40 * NIM, START + 2)); // the wallet part, at once
  assert.deepEqual(G.parts(g), { stake: 300 * NIM, wallet: 0, gifts: 0 }); // still all 300 while cooling off
  const w = G.withdrawEntry(g, 160 * NIM, 0, START + 3);
  g.entries.push(w);
  assert.deepEqual(G.parts(g), { stake: 140 * NIM, wallet: 160 * NIM, gifts: 0 }); // B1: landed, still the goal's
  g.entries.push(G.takeOutEntry(g, 160 * NIM, START + 4)); // then taken off, as asked
  assert.deepEqual(G.parts(g), { stake: 140 * NIM, wallet: 0, gifts: 0 });
  assert.equal(G.totalPrincipal([g]), 140 * NIM);
});

test('T5: stored state keeps take-outs and a take-out in progress, and nothing else', () => {
  const raw = { v: 1, goals: [{ id: 'kkkkkk', name: 'K', target: 1000 * NIM, entries: [ok('out', 5 * NIM, START)] }], unstake: { goal: 'kkkkkk', amount: 160 * NIM, at: START, takeOut: 160 * NIM, walletOut: 40 * NIM } };
  const s = G.sanitizeState(raw);
  assert.equal(s.goals[0].entries[0].kind, 'out');
  assert.equal(s.unstake.takeOut, 160 * NIM);
  assert.equal(s.unstake.walletOut, 40 * NIM); // the wallet part of a staked take-out is booked only when it lands
  assert.equal(G.sanitizeState({ ...raw, unstake: { ...raw.unstake, walletOut: 1.5 } }).unstake.walletOut, undefined);
  assert.equal(G.sanitizeState({ ...raw, unstake: { ...raw.unstake, takeOut: -1 } }).unstake.takeOut, undefined);
  assert.equal(G.sanitizeState({ ...raw, unstake: { ...raw.unstake, takeOut: '9' } }).unstake.takeOut, undefined);
});
