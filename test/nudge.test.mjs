// The wallet line on the home screen and the suggested first saving.
// The same checks run against the real code and, as a positive control, against copies with one guard switched
// off: each broken copy must fail the check that guards it, or the check proves nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as N from '../docs/js/nudge.js';
import * as W from '../docs/js/wallet.js';

const NIM = 100000;
const HTLC_130 = 12963645; // the real phone: 129.63645 NIM in the wallet's payer account, 0 in the first one
const STAKED = { active: 110000000, inactive: 0, retired: 0, total: 110000000, delegation: 'NQ08 RS08 LTKL 62QL B954 S9YP 0G3R XVKM RU2Y', inactiveFrom: null };

const fakeProvider = (answers) => ({
  getBalance: (address) => {
    const a = answers[address];
    if (a === 'timeout') return new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), 20));
    if (a === 'error') return Promise.reject(Object.assign(new Error('network'), { code: -32000 }));
    if (a === 'throw') throw new Error('sync throw');
    return Promise.resolve(a);
  },
});

/** Every rule as a list of failures, so a broken copy can be checked for the ones it should trip. */
async function failures(N, W) {
  const out = [];
  const expect = (name, ok) => { if (!ok) out.push(name); };

  // Balance > 0, nothing staked: the line shows the balance, the first saving fills in what can be spared.
  const a = N.walletNudge({ spendable: HTLC_130, noted: 0, staker: null });
  expect('balance>0 shows the line', a && a.amount === HTLC_130 && a.more === false && a.canStake === true);
  const s = N.firstSuggestion({ spendable: HTLC_130, staker: null, left: 50000 * NIM });
  expect('suggestion 128 NIM from 129.63645', s === 128 * NIM);
  expect('suggestion keeps the fee reserve', s > 0 && s <= HTLC_130 - N.FEE_RESERVE);

  // Balance 0: nothing new, no suggestion.
  expect('balance 0 hides the line', N.walletNudge({ spendable: 0, staker: null }) === null);
  expect('balance 0 suggests nothing', N.firstSuggestion({ spendable: 0, staker: null, left: 50000 * NIM }) === 0);

  // Balance unknown: never a number on screen.
  for (const unknown of [null, undefined, NaN, -1, 1.5, '12963645', Infinity]) {
    expect(`unknown ${String(unknown)} hides the line`, N.walletNudge({ spendable: unknown, staker: null }) === null);
    expect(`unknown ${String(unknown)} suggests nothing`, N.firstSuggestion({ spendable: unknown, staker: null, left: 50000 * NIM }) === 0);
  }
  expect('stake still loading hides the line', N.walletNudge({ spendable: HTLC_130, staker: undefined }) === null);
  expect('stake still loading suggests nothing', N.firstSuggestion({ spendable: HTLC_130, staker: undefined, left: 50000 * NIM }) === 0);
  expect('pending transaction hides the line', N.walletNudge({ spendable: HTLC_130, staker: null, pending: true }) === null);

  // The wallet read itself: the real phone's two accounts, and a timed-out or failed read.
  const two = ['NQ04 FIRST', 'NQ89 PAYER'];
  const ok = await W.walletBalances(two, fakeProvider({ 'NQ04 FIRST': 0, 'NQ89 PAYER': HTLC_130 }));
  expect('sums the accounts (first reads 0, payer holds it)', ok.total === HTLC_130 && ok.spendable === HTLC_130 && ok.complete === true);
  const late = await W.walletBalances(two, fakeProvider({ 'NQ04 FIRST': 0, 'NQ89 PAYER': 'timeout' }));
  expect('timed-out payer read is unknown, not 0', late.spendable === null && late.complete === false);
  expect('timed-out read shows no line', N.walletNudge({ spendable: late.spendable, staker: null }) === null);
  const err = await W.walletBalances(two, fakeProvider({ 'NQ04 FIRST': 'error', 'NQ89 PAYER': 'error' }));
  expect('failed reads are unknown', err.total === null && err.spendable === null && err.complete === false);
  const thrown = await W.walletBalances(two, fakeProvider({ 'NQ04 FIRST': 'throw', 'NQ89 PAYER': HTLC_130 }));
  expect('a read that throws is unknown, the other still counts', thrown.spendable === HTLC_130 && thrown.total === HTLC_130 && thrown.complete === false);
  const junk = await W.walletBalances(two, fakeProvider({ 'NQ04 FIRST': '5', 'NQ89 PAYER': -3 }));
  expect('junk balances are unknown', junk.spendable === null && junk.total === null);

  // Stake > 0: the line still says what's in the wallet, but nothing is filled in for the user.
  const b = N.walletNudge({ spendable: 600000000, staker: STAKED });
  expect('stake>0 still shows the wallet line', b && b.amount === 600000000 && b.canStake === true);
  expect('stake>0 suggests nothing', N.firstSuggestion({ spendable: 600000000, staker: STAKED, left: 50000 * NIM }) === 0);
  expect('stake>0 with small wallet can add', N.walletNudge({ spendable: 30 * NIM, staker: STAKED })?.canStake === true);

  // Under the network minimum with no stake: honest wording, and the suggestion goes the set-aside way.
  const c = N.walletNudge({ spendable: 50 * NIM, staker: null });
  expect('under 100 NIM: shown, cannot start a stake', c && c.canStake === false);
  expect('under 100 NIM: suggests 49', N.firstSuggestion({ spendable: 50 * NIM, staker: null, left: 50000 * NIM }) === 49 * NIM);

  // What goals already set aside isn't offered twice.
  const d = N.walletNudge({ spendable: HTLC_130, noted: 60 * NIM, staker: null });
  expect('set aside: shows only the rest, marked as more', d && d.amount === HTLC_130 - 60 * NIM && d.more === true);
  expect('set aside: whole wallet can still stake with it', d && d.canStake === true);
  expect('set aside: suggestion from the rest', N.firstSuggestion({ spendable: HTLC_130, noted: 60 * NIM, staker: null, left: 50000 * NIM }) === 68 * NIM);
  expect('set aside more than the wallet: nothing', N.walletNudge({ spendable: HTLC_130, noted: 200 * NIM, staker: null }) === null);

  // Small goals and dust.
  expect('capped by what the goal still needs', N.firstSuggestion({ spendable: HTLC_130, staker: null, left: 50 * NIM }) === 50 * NIM);
  expect('goal full: nothing', N.firstSuggestion({ spendable: HTLC_130, staker: null, left: 0 }) === 0);
  expect('dust under 2 NIM: no line', N.walletNudge({ spendable: 1.5 * NIM, staker: null }) === null);
  expect('2 NIM: line shows', N.walletNudge({ spendable: 2 * NIM, staker: null }) !== null);

  // Never more than the balance less the reserve, for any balance.
  let over = 0;
  for (let i = 0; i < 2000; i++) {
    const spend = Math.floor(Math.random() * 1e9);
    const sug = N.firstSuggestion({ spendable: spend, staker: null, left: Math.floor(Math.random() * 2e9) + 1 });
    if (sug > Math.max(0, spend - N.FEE_RESERVE) || sug % 1 !== 0) over++;
  }
  expect('random balances: suggestion within balance less reserve', over === 0);
  return out;
}

test('wallet line and first saving: every rule holds', async () => {
  assert.deepEqual(await failures(N, W), []);
});

// Positive control. Copies of the real files with one guard removed, imported from data: URLs.
const here = new URL('../docs/js/', import.meta.url);
const abs = (src) => src.replace(/from '\.\/([\w./-]+)'/g, (_, f) => `from ${JSON.stringify(new URL(f, here).href)}`);
const load = (src) => import(`data:text/javascript;base64,${Buffer.from(abs(src)).toString('base64')}`);
const real = (name) => readFileSync(new URL(name, here), 'utf8');
function mutate(src, from, to) {
  assert.ok(src.includes(from), `control can't find: ${from}`);
  return src.replace(from, to);
}

test('positive control: each guard, switched off, fails its own check', async () => {
  const controls = [
    ['no fee reserve', 'nudge', [' - FEE_RESERVE;', ';'], ['suggestion keeps the fee reserve', 'random balances: suggestion within balance less reserve']],
    ['suggests on top of a stake', 'nudge', ['(staker && staker.total > 0)', 'false'], ['stake>0 suggests nothing']],
    ['failed read counted as 0', 'wallet', ['() => null);', '() => 0);'], ['timed-out payer read is unknown, not 0', 'failed reads are unknown']],
    ['shown while a send confirms', 'nudge', ['if (pending || ', 'if ('], ['pending transaction hides the line']],
  ];
  for (const [label, file, [from, to], must] of controls) {
    const nSrc = real('nudge.js');
    const wSrc = real('wallet.js');
    const Nm = await load(file === 'nudge' ? mutate(nSrc, from, to) : nSrc);
    const Wm = await load(file === 'wallet' ? mutate(wSrc, from, to) : wSrc);
    const got = await failures(Nm, Wm);
    for (const name of must) assert.ok(got.includes(name), `${label}: expected "${name}" to fail, got ${JSON.stringify(got)}`);
  }
  // And the unmutated copies loaded the same way pass, so the loader itself isn't what fails.
  assert.deepEqual(await failures(await load(real('nudge.js')), await load(real('wallet.js'))), []);
});
