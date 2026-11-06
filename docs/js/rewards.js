// Staking rewards as this phone sees them arrive. Pure functions over plain values.
//
// Kuza can't see a pool's payout transaction under the user's address (the chain files it under the staking contract),
// so it watches the result instead: Earned (stake now, minus what went in through Kuza, minus stake from before Kuza)
// going up. Each rise is a reward event, dated when this phone first saw it; rises on the same day are added together.

const DAY = 864e5;
const MAX_EVENTS = 60;

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
