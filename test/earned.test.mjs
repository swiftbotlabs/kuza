// Earned may only show NIM the chain proves are rewards. Checked against the real mainnet history of our own test wallet
// NQ32 9CGX ... 8DKM: deposits 1,000 (create staker) + 60 + 100 (the friend's gift, staked from a second payment
// account), 60 taken out, stake 1,100 and no pool payout yet -> Earned 0, never the gift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as RW from '../docs/js/rewards.js';
import * as C from '../docs/js/chain.js';
import * as G from '../docs/js/goals.js';
import { addressHex } from '../docs/js/nim.js';
import { STAKING_CONTRACT } from '../docs/js/staking.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/nq32-mainnet-history.json', import.meta.url), 'utf8'));
const NQ32 = 'NQ32 9CGX GGYH 2DNL D7AL AQGM FHU8 SJ5U 8DKM';
const NQ43 = 'NQ43 MS6V QJLN 7GXB VSUA GHLK UVB5 YJ9K D4B5';
const NQ50 = 'NQ50 MM2Y 74UL HF5V 3P36 D9FP 4TBQ 975R TRCX';
const NOW_HTLC = 'NQ32 0DSN YTSU G7MP QD91 1BC9 NVFG 2NL8 BJ9F';
const NIM = 100000;
const STAKE = FIX.staker.balance + FIX.staker.inactiveBalance + FIX.staker.retiredBalance;

/** A pretend RPC node answering from the saved mainnet histories. */
function node(fail = new Set()) {
  return (method, params) => {
    if (method !== 'getTransactionsByAddress') throw new Error(method);
    if (fail.has(params[0])) throw new Error('rpc down');
    return FIX.history[params[0]] || [];
  };
}

test('fixture is the real wallet: 1,100 NIM staked, the staker bytes match the address', () => {
  assert.equal(STAKE, 1100 * NIM);
  assert.equal(addressHex(NQ32), '4b21e843f1136d469d54562157c788d48bc43675');
  assert.equal(addressHex('nonsense'), null);
});

/** The ledger as the app reads it: per-account sums over the wallet and the payment accounts it funded. */
const flowsOf = (owner) => (txs, more) => RW.stakeFlows(txs, owner, more);

test('real mainnet history: deposits 1,160, withdrawals 60, Earned 0 (the 100 NIM gift is a deposit, not a reward)', async () => {
  const asked = [];
  C.useBackend((m, p) => { asked.push(p[0]); return node()(m, p); });
  try {
    const { flows, keep } = await C.stakeLedger(NQ32, [NQ32, NOW_HTLC], {}, flowsOf(NQ32), C.readBudget());
    assert.deepEqual(flows, { deposits: 1160 * NIM, withdrawals: 60 * NIM, doubtful: 0, count: 4 });
    assert.equal(RW.provenEarned(STAKE, flows), 0);
    // The pool's first payout of 0.5 NIM lands in the stake: that, and only that, is Earned.
    assert.equal(RW.provenEarned(STAKE + 50000, flows), 50000);
    // The payment accounts were found from the wallet's own funding transactions, not from local notes.
    assert.deepEqual(new Set(asked), new Set([NQ32, NQ43, NQ50, NOW_HTLC]));
    // Old payment accounts are summed once and kept; the current one never is.
    assert.deepEqual(Object.keys(keep).sort(), [NQ43, NQ50].sort());
    // Next open: the kept sums stand in for the old accounts, so only the wallet and the current account are read.
    asked.length = 0;
    const again = await C.stakeLedger(NQ32, [NQ32, NOW_HTLC], keep, flowsOf(NQ32), C.readBudget());
    assert.deepEqual(again.flows, flows);
    assert.deepEqual(asked.sort(), [NQ32, NOW_HTLC].sort());
    // The wallet's account list at Connect time doesn't matter: the funding transactions lead to every payment account.
    const bare = await C.stakeLedger(NQ32, [], {}, flowsOf(NQ32), C.readBudget());
    assert.equal(RW.provenEarned(STAKE, bare.flows), 0);
  } finally {
    C.useBackend(null);
  }
});

test('a payment account that can\'t be read makes the whole answer unknown, never a guess', async () => {
  C.useBackend(node(new Set([NQ50])));
  try {
    await assert.rejects(C.stakeLedger(NQ32, [NQ32], {}, flowsOf(NQ32), C.readBudget()));
  } finally {
    C.useBackend(null);
  }
  // Had it been skipped silently, the gift would have shown as a 100 NIM reward: the overclaim this guards against.
  const partial = [...FIX.history[NQ32], ...FIX.history[NQ43]];
  assert.equal(RW.provenEarned(STAKE, RW.stakeFlows(partial, NQ32)), 100 * NIM);
});

test('the read stays inside its budget: requests, accounts, pages and time', async () => {
  let calls = 0;
  C.useBackend((m, p) => { calls++; return node()(m, p); });
  try {
    await assert.rejects(C.stakeLedger(NQ32, [NQ32], {}, flowsOf(NQ32), C.readBudget({ requests: 3 })), /budget/);
    assert.ok(calls <= 3, `calls ${calls}`);
    await assert.rejects(C.stakeLedger(NQ32, [NQ32], {}, flowsOf(NQ32), C.readBudget({ accounts: 2 })), /too many accounts/);
    await assert.rejects(C.stakeLedger(NQ32, [NQ32], {}, flowsOf(NQ32), C.readBudget({ ms: -1 })), /budget/);
    // The default budget reads this wallet in 4 requests.
    calls = 0;
    await C.stakeLedger(NQ32, [NQ32], {}, flowsOf(NQ32), C.readBudget());
    assert.equal(calls, 4);
  } finally {
    C.useBackend(null);
  }
});

test('a full page of history that can\'t be paged further is unknown', async () => {
  const page = Array.from({ length: 500 }, (_, i) => ({ hash: `h${i}`, from: 'x', to: 'y', value: 1 }));
  C.useBackend(() => page); // the same 500 again for every page: nothing new, so it can't be complete
  try {
    await assert.rejects(C.fullHistory(NQ32), /completely/);
  } finally {
    C.useBackend(null);
  }
});

test('only this staker\'s money counts; anything that can\'t be placed makes it unknown', () => {
  const hex = addressHex(NQ32);
  const other = addressHex(NQ43);
  const tx = (o) => ({ hash: Math.random().toString(36), executionResult: true, relatedAddresses: [STAKING_CONTRACT, NQ32], ...o });
  const base = [tx({ from: NQ43, to: STAKING_CONTRACT, value: 1000 * NIM, recipientData: `0501${other}`, relatedAddresses: [STAKING_CONTRACT, NQ32, NQ43] })];
  // Add-stake for someone else's staker, from our account: not ours.
  const f1 = RW.stakeFlows([...base, tx({ from: NQ43, to: STAKING_CONTRACT, value: 50 * NIM, recipientData: `06${other}` })], NQ32, [NQ43]);
  assert.equal(f1.deposits, 1000 * NIM);
  // Our add-stake, failed on chain: not counted. Counted once even if seen twice.
  const ours = tx({ from: NQ43, to: STAKING_CONTRACT, value: 20 * NIM, recipientData: `06${hex}` });
  const f2 = RW.stakeFlows([...base, ours, ours, tx({ from: NQ43, to: STAKING_CONTRACT, value: 9 * NIM, recipientData: `06${hex}`, executionResult: false })], NQ32, [NQ43]);
  assert.equal(f2.deposits, 1020 * NIM);
  // Someone else's stake removed to our address is not our withdrawal (it would inflate Earned).
  const f3 = RW.stakeFlows([...base, tx({ from: STAKING_CONTRACT, to: NQ32, value: 70 * NIM, senderData: '01', relatedAddresses: [STAKING_CONTRACT, NQ32, 'NQ07 SOME ONEE LSE0 0000 0000 0000 0000 0000'] })], NQ32);
  assert.equal(f3.withdrawals, 0);
  // A create-staker or a payment out of the contract with no related addresses can't be placed: unknown.
  assert.equal(RW.provenEarned(1000 * NIM, RW.stakeFlows([tx({ from: NQ43, to: STAKING_CONTRACT, value: 1000 * NIM, recipientData: '0501', relatedAddresses: undefined })], NQ32)), null);
  assert.equal(RW.provenEarned(1000 * NIM, RW.stakeFlows([...base, tx({ from: STAKING_CONTRACT, to: NQ32, value: 5, relatedAddresses: null })], NQ32)), null);
  // More went in than the stake and withdrawals explain: some movement wasn't seen, so unknown rather than negative.
  assert.equal(RW.provenEarned(900 * NIM, RW.stakeFlows(base, NQ32)), null);
  assert.equal(RW.provenEarned(1000 * NIM, RW.stakeFlows(base, NQ32)), 0);
  assert.equal(RW.provenEarned(NaN, RW.stakeFlows(base, NQ32)), null);
  assert.equal(RW.provenEarned(5, null), null);
});

test('a goal gets only its own share of rewards when stake outside goals exists', () => {
  const goal = G.newGoal({ id: 'gggggg', name: 'G', target: 500 * NIM, now: 0 });
  goal.entries.push({ kind: 'stake', luna: 100 * NIM, at: 1, status: 'ok' });
  // 1,100 NIM went into the stake in all, 100 of it through this goal: 11 NIM of rewards -> 1 NIM for the goal.
  assert.equal(G.earnedShare(goal, [goal], 11 * NIM, 1100 * NIM), 1 * NIM);
  assert.equal(G.earnedShare(goal, [goal], 11 * NIM), 11 * NIM); // no chain total known: the goals share it
  assert.equal(G.earnedShare(goal, [goal], 0, 1100 * NIM), 0);
});
