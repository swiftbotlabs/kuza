// The goal ledger. Pure functions over plain objects; storage is kept at the edge.
//
// A goal is a target, a date and a list of entries:
//   aside     noted, stays spendable in the wallet, no transaction
//   gift      someone paid the owner with this goal's memo (on chain, lands in the wallet)
//   stake     a confirmed staking transaction; fromWallet says how much came out of the wallet part
//   assign    stake that already existed and now counts toward this goal, no transaction
//   withdraw  a confirmed removal from stake back to the wallet. Booked since 7 Nov 2026 with toWallet: the NIM stays
//             with the goal, set aside in the wallet, until it is spent or the goal is marked done; `earned` is the
//             goal's share of rewards that came out with it. Older entries (no toWallet) meant the NIM left the goal.
//   move      stake handed on to another goal (that goal books it as assign), no transaction
//   spend     a payment made from what the goal held in the wallet, never more than that (`paid` is the whole payment)
//   out       taken back by the owner for their own use (since 8 Nov 2026): the goal stops counting that much of what it
//             held in the wallet. No transaction: the NIM is already in the wallet. Staked NIM comes out of the stake
//             first (a real withdraw, with its cooling-off), and is taken off the goal when it lands.
// status is pending, ok or failed. Only ok counts.
//
// A goal can have a plan: `weekly` Luna every `every` ('week' or 'month'). The field keeps its old name so goals saved
// before monthly plans existed still read the same.

const WEEK = 7 * 24 * 3600 * 1000;
const LUNA = 100000;
const NAME_MAX = 40;
const MAX_GIFTS = 500;
const KINDS = new Set(['aside', 'gift', 'stake', 'assign', 'withdraw', 'move', 'spend', 'out']);
export const MARKS = [25, 50, 75, 100];
const STATUSES = new Set(['ok', 'pending', 'failed']);

export function newGoal({ id, name, target, date, weekly, every, icon, now }) {
  return { id, name: String(name).slice(0, NAME_MAX), target, date: date || null, weekly: weekly || 0, every: every === 'month' ? 'month' : 'week', icon: icon || 'seed', createdAt: now, entries: [], closedAt: null, marks: [], reachedAt: null };
}

/**
 * What to put in each period to reach the target by the date, for a goal that starts now with `already` in it (the
 * new-goal form). An existing goal's form asks pace() about the goal itself, so the plan and the suggestion agree.
 */
export function suggestPlan(target, date, now, every = 'week', already = 0) {
  const g = { target, date: date || null, every: every === 'month' ? 'month' : 'week', weekly: 0, createdAt: now, entries: [] };
  return pace(g, already, now).suggest;
}

const counted = (goal) => goal.entries.filter((e) => e.status === 'ok');
const monthly = (goal) => goal.every === 'month';

/**
 * What a goal holds: in the stake, set aside in the wallet, and how much of it friends gave. Each step is kept at 0 or
 * more as it is applied, so an over-large payment or removal can never leave a debt that swallows a later gift.
 */
export function parts(goal) {
  let stake = 0;
  let wallet = 0;
  let gifts = 0;
  for (const e of counted(goal)) {
    switch (e.kind) {
      case 'aside': wallet += e.luna; break;
      case 'gift': wallet += e.luna; gifts += e.luna; break;
      case 'stake': stake += e.luna; wallet = Math.max(0, wallet - (e.fromWallet || 0)); break;
      case 'assign': stake += e.luna; break;
      case 'withdraw': {
        const out = Math.min(stake, e.luna);
        stake -= out;
        if (e.toWallet) wallet += out + (e.earned || 0); // back in the wallet, still this goal's
        break;
      }
      case 'move': stake = Math.max(0, stake - e.luna); break;
      case 'spend': case 'out': wallet = Math.max(0, wallet - e.luna); break;
      default: break;
    }
  }
  return { stake, wallet, gifts };
}

/** Rewards that left the stake with this goal's NIM (booked on its withdrawals). They're the goal's for good. */
export function rewardsTakenOut(goal) {
  return counted(goal).reduce((n, e) => n + (e.kind === 'withdraw' && e.toWallet && e.earned > 0 ? e.earned : 0), 0);
}

/**
 * The withdraw entry for NIM that has come out of the stake for this goal: at most what the goal had in the stake,
 * plus the goal's share of the rewards (`share`, worked out before the stake left) up to what came out beyond that.
 * Null when none of it was this goal's.
 */
export function withdrawEntry(goal, out, share, now) {
  const inGoal = Math.min(parts(goal).stake, Math.max(0, out));
  if (!(inGoal > 0)) return null;
  const earned = Math.min(Math.max(0, share || 0), out - inGoal);
  return { kind: 'withdraw', luna: inGoal, at: now, status: 'ok', toWallet: true, ...(earned > 0 ? { earned } : {}) };
}

/** How much of a payment of `value` Luna is booked against the goal: never more than it holds in the wallet. */
export function spendPart(goal, value) {
  return Math.min(parts(goal).wallet, Math.max(0, value || 0));
}

/**
 * Taking some of a goal's NIM back. What it holds in the wallet comes first and is free at once (`now`); the rest has
 * to come out of the stake first (`fromStake`, at most the goal's stake and its share of the rewards, `inStake`).
 */
export function takeOutPlan(goal, value, inStake) {
  const want = Math.max(0, value || 0);
  const now = Math.min(parts(goal).wallet, want);
  return { now, fromStake: Math.min(Math.max(0, inStake || 0), want - now) };
}

/** The entry for NIM taken back from what the goal holds in the wallet: never more than that. Null when it's 0. */
export function takeOutEntry(goal, value, now) {
  const luna = Math.min(parts(goal).wallet, Math.max(0, value || 0));
  return luna > 0 ? { kind: 'out', luna, at: now, status: 'ok' } : null;
}

/** Sum of what goals hold in stake, across all goals, closed or not. */
export function totalPrincipal(goals) {
  return goals.reduce((sum, g) => sum + parts(g).stake, 0);
}

/** Deposits sent but not yet confirmed by the app. They may already be in the staker's balance. */
function pendingStake(goals) {
  return goals.reduce((sum, g) => sum + g.entries.filter((e) => e.status === 'pending' && e.kind === 'stake').reduce((n, e) => n + e.luna, 0), 0);
}

/**
 * Rewards so far = what the staker holds now, minus what was there before Kuza, minus what the goals put in.
 * Deposits still confirming don't count as rewards, and it comes out as 0 rather than negative.
 */
export function earnedTotal(stakerTotal, baseline, goals) {
  return Math.max(0, (stakerTotal || 0) - (baseline || 0) - totalPrincipal(goals) - pendingStake(goals));
}

/**
 * Rewards shared out by stake. `principal` is what the chain says went into the stake in all (deposits less
 * withdrawals): stake that isn't in any goal earns its share too, so a goal never gets more than its own part.
 */
export function earnedShare(goal, goals, earned, principal = 0) {
  const open = goals.filter((g) => !g.closedAt);
  const inGoals = open.reduce((sum, g) => sum + parts(g).stake, 0);
  const all = Math.max(inGoals, Number.isSafeInteger(principal) ? principal : 0);
  // Rewards already taken out with some goal's NIM belong to that goal; only what is still in the stake is shared.
  const inStake = (earned || 0) - goals.reduce((n, g) => n + rewardsTakenOut(g), 0);
  if (!all || goal.closedAt || !(inStake > 0)) return 0;
  return Math.floor(inStake * (parts(goal).stake / all));
}

/**
 * Where a goal stands. `earned` is its share of the rewards still in the stake (part of `saved`); `earnedAll` adds the
 * rewards that came out with its NIM (already inside `wallet`), which is what the goal's Earned tile shows.
 */
export function progress(goal, earnedPart = 0) {
  const p = parts(goal);
  const saved = p.stake + p.wallet + earnedPart;
  return { ...p, earned: earnedPart, earnedAll: earnedPart + rewardsTakenOut(goal), saved, ratio: goal.target ? Math.min(1, saved / goal.target) : 0, left: Math.max(0, goal.target - saved) };
}

/** When plan period i starts. Weeks run from the goal's creation; months keep its day of the month (31 -> 30, 28...). */
export function periodStart(goal, i) {
  if (!monthly(goal)) return goal.createdAt + i * WEEK;
  const c = new Date(goal.createdAt);
  const y = c.getUTCFullYear();
  const m = c.getUTCMonth() + i;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(c.getUTCDate(), last), c.getUTCHours(), c.getUTCMinutes(), c.getUTCSeconds(), c.getUTCMilliseconds());
}

/** Which plan period a moment falls in. Period 0 is the first. */
export function planPeriod(goal, t) {
  if (!monthly(goal)) return Math.floor((t - goal.createdAt) / WEEK);
  const c = new Date(goal.createdAt);
  const d = new Date(t);
  let i = (d.getUTCFullYear() - c.getUTCFullYear()) * 12 + (d.getUTCMonth() - c.getUTCMonth());
  while (i > -1200 && t < periodStart(goal, i)) i--;
  while (i < 12000 && t >= periodStart(goal, i + 1)) i++;
  return i;
}

/** Kept for older callers: the plan period of a weekly goal. */
export const planWeek = planPeriod;

/**
 * What each plan period added to the goal, net: new money in (set aside, gifts, new stake, stake moved in from another
 * goal) less what left it (spent, moved on, taken back by the owner, or withdrawn before 7 Nov 2026, when a withdrawal
 * still left the goal).
 * Moving the goal's own NIM between wallet and stake adds nothing. A period never reads below 0.
 */
function savedByWeek(goal) {
  const net = new Map();
  const add = (e, n) => { const w = planPeriod(goal, e.at); net.set(w, (net.get(w) || 0) + n); };
  for (const e of counted(goal)) {
    switch (e.kind) {
      case 'aside': case 'gift': case 'assign': add(e, e.luna); break;
      case 'stake': add(e, e.luna - Math.min(e.luna, e.fromWallet || 0)); break;
      case 'spend': case 'move': case 'out': add(e, -e.luna); break;
      case 'withdraw': if (!e.toWallet) add(e, -e.luna); break;
      default: break;
    }
  }
  const by = new Map();
  for (const [w, n] of net) by.set(w, Math.max(0, n));
  return by;
}

/** Weeks in a row the plan was met. The running week can only add to it, never break it. */
export function streak(goal, now) {
  if (!goal.weekly) return 0;
  const by = savedByWeek(goal);
  const current = planPeriod(goal, now);
  let count = (by.get(current) || 0) >= goal.weekly ? 1 : 0;
  for (let w = current - 1; w >= 0; w--) {
    if ((by.get(w) || 0) >= goal.weekly) count++;
    else break;
  }
  return count;
}

/** The weekly reminder: is this period's amount still open, and when is it due? */
export function dueNow(goal, now) {
  if (!goal.weekly || goal.closedAt) return null;
  const w = planPeriod(goal, now);
  const saved = savedByWeek(goal).get(w) || 0;
  const left = goal.weekly - saved;
  if (left <= 0) return null;
  return { left, endsAt: periodEnd(goal, w) };
}

/**
 * The next saving the plan asks for: what's still open this period and when it's due, or, once this period is met,
 * the full amount for the next one. Null without a plan.
 */
export function nextSave(goal, now) {
  if (!goal.weekly || goal.closedAt) return null;
  const due = dueNow(goal, now);
  if (due) return { amount: due.left, by: due.endsAt, done: false };
  const w = planPeriod(goal, now);
  return { amount: goal.weekly, from: periodStart(goal, w + 1), by: periodEnd(goal, w + 1), done: true };
}

/** Up to the next whole NIM: plan amounts are typed and shown in whole NIM, so they're worked out in whole NIM. */
const wholeUp = (luna) => Math.ceil(luna / LUNA) * LUNA;

/** The goal's date as [start of that day, end of that day] in UTC, or null. */
function dateSpan(goal) {
  if (!goal.date) return null;
  const end = Date.parse(goal.date + 'T23:59:59Z');
  return Number.isNaN(end) ? null : [end - (24 * 3600 - 1) * 1000, end];
}

/**
 * How many plan periods the goal has to its date, counted from the day it was made: the periods that start before
 * the date's day does. The last of them runs to the end of the date. 0 without a date or with one before the start.
 */
export function periodsToDate(goal) {
  const span = dateSpan(goal);
  if (!span || span[1] <= goal.createdAt) return 0;
  return span[0] > goal.createdAt ? Math.max(1, planPeriod(goal, span[0] - 1) + 1) : 1;
}

/** When plan period i is due: when the next one starts, except that the last period before the date ends on the date. */
export function periodEnd(goal, i) {
  const next = periodStart(goal, i + 1);
  const total = periodsToDate(goal);
  return total && i === total - 1 ? dateSpan(goal)[1] : next;
}

/**
 * The plan math, in one place. The home card, the goal page's badge, its pace line and its "gets you there" line and
 * the goal form all read this, so they can never disagree.
 * - Periods (weeks or months) run from the moment the goal was made. A period's saving is due when the period ends,
 *   so nothing is due during the first one: a goal made today is never behind, and `status` stays null until a
 *   period has ended (nothing to compare yet).
 * - With a date, the date sets the pace: the target split over the periods to the date (`periodsToDate`), in whole
 *   NIM rounded up, owed for each period that has ended. Without a date, the plan amount does.
 * - `suggest` is what each period from this one to the date needs: what's left of the target after everything saved
 *   before this period, over the periods left including this one, in whole NIM rounded up. A new goal's form puts that
 *   same number in the plan field, so a plan made from it is never "late".
 * - `finish` is when the goal lands if the plan amount is kept from now on (gifts and rewards would only make it
 *   sooner); `late` when that falls after the date.
 * Amounts are compared in whole NIM: under half a NIM short is not "behind".
 */
export function pace(goal, saved, now) {
  const total = periodsToDate(goal);
  const span = dateSpan(goal);
  const current = Math.max(0, planPeriod(goal, now));
  const thisPeriod = savedByWeek(goal).get(current) || 0;
  const left = Math.max(0, goal.target - saved);
  const open = !total ? 0 : current < total ? total - current : now <= span[1] ? 1 : 0;
  const before = Math.max(0, saved - thisPeriod);
  const suggest = open ? { amount: wholeUp(Math.max(0, goal.target - before) / open), periods: open } : { amount: 0, periods: 0 };
  const per = total ? wholeUp(goal.target / total) : goal.weekly;
  const ended = total ? Math.min(current, total) : current;
  let status = null;
  if (per > 0 && ended >= 1) {
    const expected = Math.min(goal.target, per * ended);
    const delta = saved - expected;
    const ok = Math.round(delta / LUNA) >= 0;
    status = { expected, delta, ok, ahead: ok && delta > per / 4, by: total ? 'date' : 'plan' };
  }
  let finish = null;
  if (goal.weekly > 0 && left > 0) {
    const due = Math.max(0, goal.weekly - thisPeriod);
    const rest = left - Math.min(due, left);
    const more = rest > 0 ? Math.ceil(rest / goal.weekly) : 0;
    const k = current + more; // the period the last saving falls in
    finish = { at: periodEnd(goal, k), periods: more + (due > 0 ? 1 : 0), period: k };
  }
  const late = Boolean(finish && total && finish.period >= total);
  return { periods: total, current, status, suggest, finish, late };
}

/** When the goal is reached if the plan is kept from now on (see pace). Null without a plan or once reached. */
export function projectFinish(goal, left, now) {
  const f = pace(goal, goal.target - left, now).finish;
  return f ? { at: f.at, periods: f.periods } : null;
}

/** On plan, ahead or behind (see pace). Null when there's nothing to compare yet. */
export function planStatus(goal, saved, now) {
  return pace(goal, saved, now).status;
}

/** The highest 25/50/75/100% mark this goal has passed and not yet celebrated, or 0. Goals from before marks: 0. */
export function newMark(goal, ratio) {
  if (!Array.isArray(goal.marks)) return 0;
  const fresh = MARKS.filter((m) => ratio * 100 >= m && !goal.marks.includes(m));
  return fresh.length ? fresh[fresh.length - 1] : 0;
}

/** Marks already passed, for goals saved before marks existed: they start from where they are, without a party. */
export function passedMarks(ratio) {
  return MARKS.filter((m) => ratio * 100 >= m);
}

/** Last n plan weeks, oldest first, for the streak strip. */
export function weekStrip(goal, now, n = 8) {
  const by = savedByWeek(goal);
  const current = planPeriod(goal, now);
  const out = [];
  for (let w = Math.max(0, current - n + 1); w <= current; w++) {
    const amount = by.get(w) || 0;
    out.push({ week: w, amount, met: goal.weekly ? amount >= goal.weekly : amount > 0, current: w === current });
  }
  return out;
}

/** Ahead of or behind the pace to the date (see pace). Null without a date or before anything is due. */
export function onTrack(goal, saved, now) {
  const st = pace(goal, saved, now).status;
  return st && st.by === 'date' ? st : null;
}

/** Merge gifts read from the chain into the goals. Returns how many were new. */
export function mergeGifts(goals, gifts) {
  let added = 0;
  for (const gift of gifts) {
    const goal = goals.find((g) => g.id === gift.goal);
    if (!goal || goal.entries.some((e) => e.hash === gift.hash)) continue;
    if (goal.entries.filter((e) => e.kind === 'gift').length >= MAX_GIFTS) continue;
    goal.entries.push({ kind: 'gift', luna: gift.luna, hash: gift.hash, from: gift.from, note: gift.note, at: gift.at, status: 'ok' });
    added++;
  }
  return added;
}

function cleanEntry(e) {
  if (!e || !KINDS.has(e.kind) || !Number.isSafeInteger(e.luna) || e.luna < 0) return null;
  const out = { kind: e.kind, luna: e.luna, at: Math.abs(e.at) <= 8.64e15 ? e.at : 0, status: STATUSES.has(e.status) ? e.status : 'failed' };
  if (typeof e.hash === 'string' && /^[0-9a-fA-F]{64}$/.test(e.hash)) out.hash = e.hash;
  if (Number.isSafeInteger(e.fromWallet) && e.fromWallet >= 0) out.fromWallet = e.fromWallet;
  if (e.toWallet === true) out.toWallet = true;
  if (Number.isSafeInteger(e.earned) && e.earned > 0) out.earned = e.earned;
  if (Number.isSafeInteger(e.paid) && e.paid > 0) out.paid = e.paid;
  if (Number.isSafeInteger(e.block)) out.block = e.block;
  if (typeof e.from === 'string') out.from = e.from.slice(0, 64);
  if (typeof e.note === 'string') out.note = e.note.slice(0, 60);
  if (typeof e.ref === 'string') out.ref = e.ref.slice(0, NAME_MAX);
  if (Number.isFinite(e.sats) && e.sats > 0 && e.sats <= 21e14) out.sats = e.sats;
  return out;
}

/**
 * Switching the wallet's account: the other account's goals come in, but device-wide things come along: the language,
 * the counting choice, and every Lightning invoice already handed to the wallet (so a switch can't re-send one).
 */
export function carryOver(prev, next) {
  const tried = [...new Set([...(prev?.lnTried || []), ...(next?.lnTried || [])])].slice(-50);
  return { ...next, lang: prev?.lang ?? null, noCount: prev?.noCount === true, lnTried: tried };
}

/** Validate a stored state blob; drop anything that doesn't look right. */
export function sanitizeState(raw) {
  const out = { v: 1, address: null, accounts: [], baseline: null, goals: [], validator: null, seen: false, noCount: false, lang: null, op: null, unstake: null, rewards: null, lnTried: [], stakeCache: {} };
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return out;
  if (typeof raw.address === 'string') out.address = raw.address;
  if (Number.isSafeInteger(raw.baseline) && raw.baseline >= 0) out.baseline = raw.baseline;
  if (typeof raw.validator === 'string') out.validator = raw.validator;
  if (typeof raw.lang === 'string') out.lang = raw.lang;
  out.seen = raw.seen === true;
  if (raw.op && typeof raw.op.kind === 'string' && Number(raw.op.at)) out.op = { kind: raw.op.kind, hash: typeof raw.op.hash === 'string' ? raw.op.hash : null, at: Number(raw.op.at) };
  if (raw.unstake && typeof raw.unstake === 'object' && Number.isSafeInteger(raw.unstake.amount)) {
    out.unstake = { goal: typeof raw.unstake.goal === 'string' ? raw.unstake.goal : null, amount: raw.unstake.amount, at: Number(raw.unstake.at) || 0 };
    if (Number.isSafeInteger(raw.unstake.removing)) out.unstake.removing = raw.unstake.removing;
    if (Number.isSafeInteger(raw.unstake.takeOut) && raw.unstake.takeOut > 0) out.unstake.takeOut = raw.unstake.takeOut;
    if (Number.isSafeInteger(raw.unstake.walletOut) && raw.unstake.walletOut > 0) out.unstake.walletOut = raw.unstake.walletOut;
  }
  out.noCount = raw.noCount === true;
  // Lightning invoices already handed to the wallet (SHA-256 only), so the same one is never paid twice from Kuza.
  if (Array.isArray(raw.lnTried)) out.lnTried = raw.lnTried.filter((x) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)).slice(-50);
  // Stake movements of old payment accounts, summed: those accounts never change again, so they're read once.
  if (raw.stakeCache && typeof raw.stakeCache === 'object' && !Array.isArray(raw.stakeCache)) {
    for (const [addr, v] of Object.entries(raw.stakeCache).slice(0, 60)) {
      const ok = (n) => Number.isSafeInteger(n) && n >= 0;
      if (typeof addr === 'string' && addr.length <= 64 && v && ok(v.deposits) && ok(v.withdrawals) && ok(v.doubtful) && ok(v.count)) {
        out.stakeCache[addr] = { deposits: v.deposits, withdrawals: v.withdrawals, doubtful: v.doubtful, count: v.count };
      }
    }
  }
  if (Array.isArray(raw.accounts)) out.accounts = raw.accounts.filter((a) => typeof a === 'string' && a.length <= 64).slice(0, 4);
  if (raw.rewards && typeof raw.rewards === 'object' && Number.isSafeInteger(raw.rewards.last) && raw.rewards.last >= 0) {
    const events = Array.isArray(raw.rewards.events) ? raw.rewards.events : [];
    out.rewards = {
      last: raw.rewards.last,
      since: Number.isFinite(raw.rewards.since) ? raw.rewards.since : 0,
      events: events.filter((e) => e && Number.isSafeInteger(e.luna) && e.luna > 0 && Number.isFinite(e.at)).map((e) => ({ at: e.at, luna: e.luna })).slice(-60),
    };
  }
  if (Array.isArray(raw.goals)) {
    for (const g of raw.goals.slice(0, 50)) {
      if (!g || typeof g.id !== 'string' || typeof g.name !== 'string' || !Number.isSafeInteger(g.target) || !Array.isArray(g.entries)) continue;
      const goal = { id: g.id, name: g.name.slice(0, NAME_MAX), target: g.target, date: typeof g.date === 'string' && !Number.isNaN(Date.parse(`${g.date}T12:00:00Z`)) ? g.date : null, weekly: Number.isSafeInteger(g.weekly) && g.weekly >= 0 ? g.weekly : 0, every: g.every === 'month' ? 'month' : 'week', icon: typeof g.icon === 'string' ? g.icon : 'seed', createdAt: Number.isFinite(g.createdAt) ? g.createdAt : 0, closedAt: Number.isFinite(g.closedAt) ? g.closedAt : null, reachedAt: Number.isFinite(g.reachedAt) ? g.reachedAt : null, sharedAt: Number.isFinite(g.sharedAt) ? g.sharedAt : null, entries: g.entries.map(cleanEntry).filter(Boolean).slice(-2000) };
      // Goals saved before marks existed have none: the app fills them in from where the goal stands, without a party.
      if (Array.isArray(g.marks)) goal.marks = g.marks.filter((m) => MARKS.includes(m));
      out.goals.push(goal);
    }
  }
  return out;
}
