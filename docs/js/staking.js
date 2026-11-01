// The staking rules Kuza depends on, all in one place.
//
// Sources, checked 2026-11-01:
//  - getPolicyConstants on rpc.nimiqwatch.com: minimumStake 10,000,000 Luna (100 NIM), blocksPerEpoch 43,200,
//    blockSeparationTime 1000 ms, jailEpochs 8, genesisBlockNumber 3,456,000 (testnet 3,032,010).
//  - core-rs-albatross, staking_contract/staker.rs: inactive stake is released at
//    inactiveFrom + blocksPerEpoch + 1, where inactiveFrom = the next election block after set-active-stake.
//    RetireStake only works on released inactive stake. RemoveStake must take the whole retired balance.
//    active + inactive must stay 0 or at least the minimum, and so must the total once all of it is retired.
//  - A real mainnet staker: set-active block 61,651,396, retire block 61,738,190, remove 5 blocks later.

export const MIN_STAKE = 10_000_000; // Luna
export const BLOCKS_PER_EPOCH = 43_200;
export const BLOCK_MS = 1000;
export const JAIL_EPOCHS = 8;
export const GENESIS = { mainnet: 3_456_000, testnet: 3_032_010 };
export const STAKING_CONTRACT = 'NQ77 0000 0000 0000 0000 0000 0000 0000 0001';

export function electionBlockAfter(height, network = 'mainnet') {
  const g = GENESIS[network] ?? GENESIS.mainnet;
  return g + (Math.floor((height - g) / BLOCKS_PER_EPOCH) + 1) * BLOCKS_PER_EPOCH;
}

/** First block at which inactive stake that became inactive at inactiveFrom can be retired. */
export function releaseBlock(inactiveFrom) {
  return inactiveFrom + BLOCKS_PER_EPOCH + 1;
}

/** If someone starts unstaking at this height, when is it released? */
export function releaseIfStartedAt(height, network = 'mainnet') {
  return releaseBlock(electionBlockAfter(height, network));
}

export function blocksToMs(blocks) {
  return Math.max(0, blocks) * BLOCK_MS;
}

/** Balances from getStakerByAddress, or null. */
export function normalizeStaker(raw) {
  if (!raw) return null;
  const active = Number(raw.balance ?? raw.activeBalance ?? 0);
  const inactive = Number(raw.inactiveBalance ?? 0);
  const retired = Number(raw.retiredBalance ?? 0);
  const inactiveFrom = raw.inactiveFrom ?? null;
  // These numbers go into transactions, so anything odd stops here rather than becoming NaN later.
  if (![active, inactive, retired].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error('bad staker data');
  if (inactiveFrom !== null && !Number.isSafeInteger(inactiveFrom)) throw new Error('bad staker data');
  return {
    active,
    inactive,
    retired,
    total: active + inactive + retired,
    delegation: raw.delegation || null,
    inactiveFrom,
  };
}

/**
 * Where a saving of `amount` Luna goes:
 *  - 'add'   the wallet already has a staker: AddStake, any amount that keeps active + inactive >= 100 NIM
 *  - 'new'   no staker yet and amount >= 100 NIM: CreateStaker with a chosen validator
 *  - 'aside' no staker and under 100 NIM: stays in the wallet, the goal only notes it
 */
export function saveRoute(amount, staker) {
  if (!Number.isSafeInteger(amount) || amount <= 0) return { route: 'invalid' };
  if (staker) {
    const after = staker.active + staker.inactive + amount;
    if (after >= MIN_STAKE) return { route: 'add' };
    return { route: 'aside', short: MIN_STAKE - after };
  }
  if (amount >= MIN_STAKE) return { route: 'new' };
  return { route: 'aside', short: MIN_STAKE - amount };
}

/** What the withdraw screen should show right now. */
export function withdrawStage(staker, height, jailReleaseBlock = 0) {
  if (!staker) return { stage: 'none' };
  if (staker.retired > 0) return { stage: 'remove', amount: staker.retired };
  if (staker.inactive > 0) {
    const release = Math.max(releaseBlock(staker.inactiveFrom ?? height), jailReleaseBlock);
    if (height >= release) return { stage: 'retire', amount: staker.inactive, release };
    return { stage: 'cooling', amount: staker.inactive, release, blocksLeft: release - height };
  }
  if (staker.active > 0) return { stage: 'active', amount: staker.active };
  return { stage: 'none' };
}

/**
 * Can `amount` be taken out of the stake? What remains must be 0 or at least 100 NIM.
 * Returns { ok, max, reason }. inactive already on its way out counts as part of what leaves.
 */
export function checkWithdraw(amount, staker) {
  const nonRetired = staker ? staker.active + staker.inactive : 0;
  if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, reason: 'invalid' };
  if (amount > nonRetired) return { ok: false, reason: 'too_much', max: nonRetired };
  const rest = nonRetired - amount;
  if (rest > 0 && rest < MIN_STAKE) {
    return { ok: false, reason: 'dust', max: nonRetired - MIN_STAKE, all: nonRetired };
  }
  return { ok: true };
}

/**
 * How much inactive stake can be retired now. A pool's last restake can land in active stake while the rest
 * cools off. If that leaves active + inactive between 0 and 100 NIM the network refuses the retire, so enough
 * has to stay behind to reach 100 NIM. Returns { amount, leaves }; amount 0 means nothing can be retired as is.
 */
export function retirePlan(staker) {
  if (!staker || staker.inactive <= 0) return { amount: 0, leaves: 0 };
  if (staker.active === 0 || staker.active >= MIN_STAKE) return { amount: staker.inactive, leaves: 0 };
  const leaves = MIN_STAKE - staker.active;
  return { amount: Math.max(0, staker.inactive - leaves), leaves };
}

const DECAY_PER_MS = 1 - 0.9999999999960264;
const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

/**
 * Network-wide gross reward rate estimate: new NIM per year / NIM staked.
 * supply and staked are in Luna, from the validators API. Before the pool fee.
 */
export function estimateGrossRate(totalSupply, staked, maxSupply = 21e14) {
  if (!(totalSupply > 0) || !(staked > 0) || totalSupply >= maxSupply) return null;
  const minted = (maxSupply - totalSupply) * (1 - Math.exp(-DECAY_PER_MS * MS_PER_YEAR));
  return minted / staked;
}
