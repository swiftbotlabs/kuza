// What the home screen says about NIM sitting in the wallet, and the amount a first saving suggests.
// Pure functions over plain values. A balance that couldn't be read is null and is never treated as 0.

import { LUNA } from './nim.js';
import { saveRoute } from './staking.js';

/** Kept back in every suggestion so the wallet can still pay a fee. */
export const FEE_RESERVE = LUNA;

const isAmount = (n) => Number.isSafeInteger(n) && n >= 0;

/** Whole NIM the wallet could put toward a goal: spendable, less what goals already set aside and the fee reserve. */
export function spare(spendable, noted = 0) {
  if (!isAmount(spendable)) return 0;
  const free = spendable - (isAmount(noted) ? noted : 0) - FEE_RESERVE;
  return free >= LUNA ? Math.floor(free / LUNA) * LUNA : 0;
}

/**
 * The wallet line under the stake card, or null when there's nothing true to say.
 *   spendable  Luna the wallet can send now; null when the read failed or timed out
 *   noted      Luna the open goals already set aside in the wallet
 *   staker     normalized staker, null for none, undefined while it's still loading
 *   pending    a transaction is still confirming, so the balance may be out of date
 * Returns { amount, more, canStake }: amount is what isn't in a goal yet, more says some of the wallet already is,
 * canStake says the wallet could make or add to a stake (a new stake needs the network's 100 NIM).
 */
export function walletNudge({ spendable, noted = 0, staker, pending = false }) {
  if (pending || staker === undefined || !isAmount(spendable)) return null;
  if (!spare(spendable, noted)) return null;
  const set = isAmount(noted) ? noted : 0;
  const { route } = saveRoute(spare(spendable, 0), staker);
  return { amount: spendable - set, more: set > 0, canStake: route === 'new' || route === 'add' };
}

/**
 * What to fill in for a saving while nothing is staked yet: what the wallet can spare, up to what the goal still
 * needs. 0 means no suggestion: balance unknown, too little, a stake already there, or the goal is full.
 */
export function firstSuggestion({ spendable, noted = 0, staker, left }) {
  if (staker === undefined || (staker && staker.total > 0)) return 0;
  if (!(Number.isSafeInteger(left) && left > 0)) return 0;
  const free = spare(spendable, noted);
  return free ? Math.min(free, left) : 0;
}
