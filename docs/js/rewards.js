// Staking rewards as this phone sees them arrive. Pure functions over plain values.
//
// Kuza can't see a pool's payout transaction under the user's address (the chain files it under the staking contract),
// so it watches the result instead: Earned (stake now, minus what went in through Kuza, minus stake from before Kuza)
// going up. Each rise is a reward event, dated when this phone first saw it; rises on the same day are added together.

import { STAKING_CONTRACT } from './staking.js';
import { addressHex } from './nim.js';

const DAY = 864e5;
const MAX_EVENTS = 60;

/**
 * Money into and out of the user's stake, from the chain history of the wallet's own accounts (the wallet address and
 * every payment account it funded). Nothing local is trusted here.
 *   deposit     a create-staker (data 05..) naming this staker, or an add-stake (data 06 + the staker's 20 bytes)
 *   withdrawal  a payment from the staking contract to one of the wallet's accounts whose related addresses are all
 *               the wallet's own (so it was this staker's stake leaving, not someone else's)
 *   doubtful    a staking transaction that can't be placed: then nothing is proven
 * Failed transactions don't count; each transaction counts once.
 */
export function stakeFlows(txs, owner, accounts = []) {
  const mine = new Set([owner, ...accounts].filter(Boolean));
  const hex = addressHex(owner);
  const seen = new Set();
  let deposits = 0;
  let withdrawals = 0;
  let doubtful = 0;
  let count = 0;
  for (const tx of txs || []) {
    if (!tx || typeof tx.hash !== 'string' || seen.has(tx.hash) || tx.executionResult === false) continue;
    seen.add(tx.hash);
    const into = tx.to === STAKING_CONTRACT && tx.from !== STAKING_CONTRACT;
    const out = tx.from === STAKING_CONTRACT && mine.has(tx.to);
    if (!into && !out) continue;
    if (!Number.isSafeInteger(tx.value) || tx.value < 0) { doubtful++; continue; }
    const related = Array.isArray(tx.relatedAddresses) ? tx.relatedAddresses : null;
    if (into) {
      const data = typeof tx.recipientData === 'string' ? tx.recipientData.toLowerCase() : '';
      if (data.startsWith('06')) {
        if (data.slice(2, 42) === hex) { deposits += tx.value; count++; }
      } else if (data.startsWith('05')) {
        if (!related) doubtful++;
        else if (related.includes(owner)) { deposits += tx.value; count++; }
      }
      // 07 update, 08 set active, 09 retire move no money into the stake.
    } else if (!related) {
      doubtful++;
    } else if (related.every((a) => a === STAKING_CONTRACT || mine.has(a))) {
      withdrawals += tx.value;
      count++;
    }
  }
  return { deposits, withdrawals, doubtful, count };
}

/**
 * Rewards the chain proves: the stake now (active + inactive + retired) minus every deposit plus every withdrawal.
 * Null when that can't be proven: a doubtful transaction, or a result below zero (some movement wasn't seen).
 */
export function provenEarned(stakeTotal, flows) {
  if (!flows || flows.doubtful || !Number.isSafeInteger(stakeTotal) || stakeTotal < 0) return null;
  const earned = stakeTotal - flows.deposits + flows.withdrawals;
  return Number.isSafeInteger(earned) && earned >= 0 ? earned : null;
}

/**
 * rw       the stored record { last, since, events: [{ at, luna }] }, or null before the first look
 * earned   Earned right now, in Luna (never negative)
 * now      ms
 * steady   false while a deposit or withdrawal is still confirming: then nothing is booked, the numbers may be mid-change
 * Returns the new record (a new object; rw itself isn't changed) and how much was new.
 */
export function trackRewards(rw, earned, now, steady = true) {
  if (!Number.isSafeInteger(earned) || earned < 0) return { rw, added: 0 };
  if (!rw) return { rw: { last: earned, since: now, events: [] }, added: 0 };
  if (!steady) return { rw, added: 0 };
  if (earned < rw.last) return { rw: { ...rw, last: earned }, added: 0 }; // stake left through a withdrawal
  if (earned === rw.last) return { rw, added: 0 };
  const added = earned - rw.last;
  const events = rw.events.slice();
  const prev = events[events.length - 1];
  if (prev && Math.floor(prev.at / DAY) === Math.floor(now / DAY)) events[events.length - 1] = { at: prev.at, luna: prev.luna + added };
  else events.push({ at: now, luna: added });
  return { rw: { ...rw, last: earned, events: events.slice(-MAX_EVENTS) }, added };
}

/** The most recent reward event, or null. */
export function lastReward(rw) {
  return rw?.events?.length ? rw.events[rw.events.length - 1] : null;
}
