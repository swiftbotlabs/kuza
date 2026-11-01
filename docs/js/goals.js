// The goal ledger. Pure functions over plain objects; storage is kept at the edge.
//
// A goal is a target, a date and a list of entries:
//   aside     noted, stays spendable in the wallet, no transaction
//   gift      someone paid the owner with this goal's memo (on chain, lands in the wallet)
//   stake     a confirmed staking transaction; fromWallet says how much came out of the wallet part
//   assign    stake that already existed and now counts toward this goal, no transaction
//   withdraw  a confirmed removal from stake back to the wallet
// status is pending, ok or failed. Only ok counts.

const WEEK = 7 * 24 * 3600 * 1000;
const NAME_MAX = 40;
const MAX_GIFTS = 500;
const KINDS = new Set(['aside', 'gift', 'stake', 'assign', 'withdraw']);
const STATUSES = new Set(['ok', 'pending', 'failed']);

export function newGoal({ id, name, target, date, weekly, icon, now }) {
  return { id, name: String(name).slice(0, NAME_MAX), target, date: date || null, weekly: weekly || 0, icon: icon || 'seed', createdAt: now, entries: [], closedAt: null };
}

export function weeksUntil(date, now) {
  if (!date) return 0;
  const end = Date.parse(date + 'T23:59:59Z');
  if (Number.isNaN(end) || end <= now) return 0;
  return Math.max(1, Math.ceil((end - now) / WEEK));
}

export function suggestWeekly(target, date, now, already = 0) {
  const weeks = weeksUntil(date, now);
  if (!weeks) return 0;
  return Math.ceil(Math.max(0, target - already) / weeks);
}

const counted = (goal) => goal.entries.filter((e) => e.status === 'ok');

export function parts(goal) {
  let stake = 0;
  let wallet = 0;
  let gifts = 0;
  for (const e of counted(goal)) {
    switch (e.kind) {
      case 'aside': wallet += e.luna; break;
      case 'gift': wallet += e.luna; gifts += e.luna; break;
      case 'stake': stake += e.luna; wallet -= e.fromWallet || 0; break;
      case 'assign': stake += e.luna; break;
      case 'withdraw': stake -= e.luna; break;
      default: break;
    }
  }
  return { stake: Math.max(0, stake), wallet: Math.max(0, wallet), gifts };
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

/** Rewards shared out by each open goal's stake. */
export function earnedShare(goal, goals, earned) {
  const open = goals.filter((g) => !g.closedAt);
  const all = open.reduce((sum, g) => sum + parts(g).stake, 0);
  if (!all || goal.closedAt) return 0;
  return Math.floor(earned * (parts(goal).stake / all));
}

export function progress(goal, earnedPart = 0) {
  const p = parts(goal);
  const saved = p.stake + p.wallet + earnedPart;
  return { ...p, earned: earnedPart, saved, ratio: goal.target ? Math.min(1, saved / goal.target) : 0, left: Math.max(0, goal.target - saved) };
}

/** Plan weeks run from the goal's creation. Week 0 is the first week. */
export function planWeek(goal, t) {
  return Math.floor((t - goal.createdAt) / WEEK);
}

function savedByWeek(goal) {
  const by = new Map();
  for (const e of counted(goal)) {
    if (!['aside', 'stake', 'gift'].includes(e.kind)) continue;
    if (e.kind === 'stake' && e.fromWallet >= e.luna) continue; // moved, not new money
    const w = planWeek(goal, e.at);
    by.set(w, (by.get(w) || 0) + e.luna - (e.fromWallet || 0));
  }
  return by;
}

/** Weeks in a row the plan was met. The running week can only add to it, never break it. */
export function streak(goal, now) {
  if (!goal.weekly) return 0;
  const by = savedByWeek(goal);
  const current = planWeek(goal, now);
  let count = (by.get(current) || 0) >= goal.weekly ? 1 : 0;
  for (let w = current - 1; w >= 0; w--) {
    if ((by.get(w) || 0) >= goal.weekly) count++;
    else break;
  }
  return count;
}

/** The weekly reminder: is this week's amount still open, and when does the week end? */
export function dueNow(goal, now) {
  if (!goal.weekly || goal.closedAt) return null;
  const w = planWeek(goal, now);
  const saved = savedByWeek(goal).get(w) || 0;
  const left = goal.weekly - saved;
  if (left <= 0) return null;
  return { left, endsAt: goal.createdAt + (w + 1) * WEEK };
}

/** Last n plan weeks, oldest first, for the streak strip. */
export function weekStrip(goal, now, n = 8) {
  const by = savedByWeek(goal);
  const current = planWeek(goal, now);
  const out = [];
  for (let w = Math.max(0, current - n + 1); w <= current; w++) {
    const amount = by.get(w) || 0;
    out.push({ week: w, amount, met: goal.weekly ? amount >= goal.weekly : amount > 0, current: w === current });
  }
  return out;
}

/** Are we ahead of or behind a straight line from start to target date? */
export function onTrack(goal, saved, now) {
  if (!goal.date) return null;
  const end = Date.parse(goal.date + 'T23:59:59Z');
  if (Number.isNaN(end) || end <= goal.createdAt) return null;
  const share = Math.min(1, Math.max(0, (now - goal.createdAt) / (end - goal.createdAt)));
  const expected = Math.floor(goal.target * share);
  return { expected, delta: saved - expected, ok: saved >= expected };
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
  const out = { kind: e.kind, luna: e.luna, at: Number.isFinite(e.at) ? e.at : 0, status: STATUSES.has(e.status) ? e.status : 'failed' };
  if (typeof e.hash === 'string' && /^[0-9a-fA-F]{64}$/.test(e.hash)) out.hash = e.hash;
  if (Number.isSafeInteger(e.fromWallet) && e.fromWallet >= 0) out.fromWallet = e.fromWallet;
  if (Number.isSafeInteger(e.block)) out.block = e.block;
  if (typeof e.from === 'string') out.from = e.from.slice(0, 64);
  if (typeof e.note === 'string') out.note = e.note.slice(0, 60);
  return out;
}

/** Validate a stored state blob; drop anything that doesn't look right. */
export function sanitizeState(raw) {
  const out = { v: 1, address: null, baseline: null, goals: [], validator: null, seen: false, noCount: false, lang: null, op: null, unstake: null };
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
  }
  out.noCount = raw.noCount === true;
  if (Array.isArray(raw.goals)) {
    for (const g of raw.goals.slice(0, 50)) {
      if (!g || typeof g.id !== 'string' || typeof g.name !== 'string' || !Number.isSafeInteger(g.target) || !Array.isArray(g.entries)) continue;
      out.goals.push({ id: g.id, name: g.name.slice(0, NAME_MAX), target: g.target, date: typeof g.date === 'string' && !Number.isNaN(Date.parse(`${g.date}T12:00:00Z`)) ? g.date : null, weekly: Number.isSafeInteger(g.weekly) ? g.weekly : 0, icon: typeof g.icon === 'string' ? g.icon : 'seed', createdAt: Number.isFinite(g.createdAt) ? g.createdAt : 0, closedAt: Number.isFinite(g.closedAt) ? g.closedAt : null, entries: g.entries.map(cleanEntry).filter(Boolean).slice(-2000) });
    }
  }
  return out;
}
