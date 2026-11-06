// Kuza: savings goals on top of the user's own NIM stake.
// Kuza holds nothing and sends nothing by itself. Money only moves through Nimiq Pay's own approval sheets.

import { LUNA, toLuna, plainNim, fmtNim, fmtFiat, shortAddress, normalizeAddress, newId, sha256Hex } from './nim.js';
import * as S from './staking.js';
import * as G from './goals.js';
import * as J from './jar.js';
import * as C from './chain.js';
import * as W from './wallet.js';
import * as A from './api.js';
import * as N from './nudge.js';
import * as I from './invite.js';
import * as RW from './rewards.js';
import * as P from './spend.js';
import { qrMatrix, qrPath } from './qr.js';
import { h, svg, icon, hexRing, logo, openSheet, closeSheet, sheetOpen, toast, copyText, GOAL_ICONS } from './ui.js';
import { t, tn, setLang, pickLang, LANGS, lang } from './i18n.js';

const params = new URLSearchParams(location.search);
const DEMO = params.get('demo') === '1' && !W.inHost(); // the pretend wallet never runs inside the real one
const REPO = 'https://github.com/swiftbotlabs/kuza';
const APP_URL = I.APP_URL;
const PLATFORM = I.platformOf(navigator.userAgent, navigator.maxTouchPoints || 0);
const HOUR = 3600e3;
const TX_WINDOW = 2.5 * HOUR; // a transaction not mined after its validity window never will be

const R = {
  network: 'mainnet', fiat: null, accounts: [], fresh: false, height: null, staker: undefined, wallet: null, spendable: null, walletComplete: false,
  validators: [], market: null, stats: null, online: true, syncedAt: 0, syncing: false, jar: null, jail: 0, gifts: null,
  banner: null, celebrate: null, openNew: undefined,
};
let st = G.sanitizeState(null);
const root = () => document.getElementById('app');

/* ---------- storage ---------- */

const storeKey = () => `kuza.${DEMO ? 'demo' : 'v1'}.${R.network}`;

function loadState(key = storeKey()) {
  try {
    return G.sanitizeState(JSON.parse(localStorage.getItem(key)));
  } catch {
    return G.sanitizeState(null);
  }
}

function saveState() {
  try {
    localStorage.setItem(storeKey(), JSON.stringify(st));
  } catch { /* storage off: the session still works */ }
}

function adoptAddress(address) {
  if (st.address === address) return;
  try {
    if (st.address) localStorage.setItem(`${storeKey()}.${st.address.replace(/\s/g, '')}`, JSON.stringify(st));
    const other = localStorage.getItem(`${storeKey()}.${address.replace(/\s/g, '')}`);
    const prefs = { lang: st.lang, noCount: st.noCount };
    st = G.sanitizeState(other ? JSON.parse(other) : null);
    Object.assign(st, prefs);
  } catch {
    st = G.sanitizeState(null);
  }
  st.address = address;
  saveState();
}

/* ---------- small formatters ---------- */

const nim = (luna, dec) => `${fmtNim(luna, lang(), dec)} NIM`;
const fiatCode = () => R.fiat || 'USD';

function fiat(luna) {
  const prices = R.market?.price || {};
  const own = prices[fiatCode().toLowerCase()];
  return own ? fmtFiat(luna, own, fiatCode(), lang()) : fmtFiat(luna, prices.usd, 'USD', lang());
}

const validDate = (ms) => Math.abs(ms) <= 8.64e15;

function when(ms) {
  if (!validDate(ms)) return '';
  return new Intl.DateTimeFormat(lang(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
}

function day(ms) {
  if (!validDate(ms)) return '';
  return new Intl.DateTimeFormat(lang(), { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ms));
}

function shortDay(ms) {
  if (!validDate(ms)) return '';
  return new Intl.DateTimeFormat(lang(), { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms));
}

/** "a week" / "a month" style labels for a goal's plan period. */
const per = (goal) => (goal.every === 'month' ? 'month' : 'week');

function dateText(date) {
  return date ? day(Date.parse(date + 'T12:00:00Z')) : '';
}

function hours(blocks) {
  const hrs = S.blocksToMs(blocks) / HOUR;
  if (hrs < 1) return t('time.minutes', { n: Math.max(1, Math.round(hrs * 60)) });
  return t('time.hours', { n: Math.round(hrs) });
}

/** A yearly reward estimate. With a fee it's after that fee; with none it's before any pool fee, and says so. */
function rateText(fee = null) {
  const gross = R.market?.rate;
  if (!gross) return null;
  const net = typeof fee === 'number' && fee >= 0 && fee <= 1 ? gross * (1 - fee) : gross;
  return new Intl.NumberFormat(lang(), { style: 'percent', maximumFractionDigits: 1 }).format(net);
}

/** The estimate line for the user's own pool: after its real fee when the fee is known, else before pool fees. */
function rateLine() {
  const pool = poolOf(R.staker?.delegation);
  if (pool && typeof pool.fee === 'number') {
    const rate = rateText(pool.fee);
    return rate ? t('how.a3rate', { rate, name: pool.name, fee: fmtPct(pool.fee) }) : null;
  }
  const gross = rateText(null);
  return gross ? t('how.a3gross', { rate: gross }) : null;
}

/**
 * Earned, only as the chain proves it: stake now minus every deposit into it plus every withdrawal, read from the
 * history of the wallet's own accounts (C.stakeLedger, RW.stakeFlows), within a read budget. R.proven.earned is null when that can't
 * be read completely; R.proven is undefined before the first read. earned() is for progress maths and counts only proof.
 */
const earned = () => (Number.isSafeInteger(R.proven?.earned) ? R.proven.earned : 0);
const earnedLabel = () => (R.proven === undefined ? '…' : R.proven.earned === null ? t('rw.unknownShort') : `+${nim(R.proven.earned)}`);
const openGoals = () => st.goals.filter((g) => !g.closedAt);
const findGoal = (id) => st.goals.find((g) => g.id === id);
const poolOf = (address) => R.validators.find((v) => v.address === address) || null;

function goalProgress(goal) {
  return G.progress(goal, G.earnedShare(goal, st.goals, earned(), R.proven?.net ?? 0));
}

function bestPool() {
  if (st.validator) {
    const chosen = poolOf(st.validator);
    if (chosen) return chosen;
  }
  return R.validators[0] || null;
}

/* ---------- chain sync ---------- */

async function checkPending() {
  let changed = false;
  for (const goal of st.goals) {
    for (const e of goal.entries) {
      if (e.status !== 'pending') continue;
      if (e.hash) {
        const tx = await C.getTx(e.hash).catch(() => null);
        if (tx?.blockNumber) {
          e.status = tx.executionResult === false ? 'failed' : 'ok';
          e.block = tx.blockNumber;
          changed = true;
          continue;
        }
      } else if (e.kind === 'stake' && R.staker && R.staker.total >= (st.baseline ?? 0) + G.totalPrincipal(st.goals) + e.luna) {
        e.status = 'ok';
        changed = true;
        continue;
      }
      if (Date.now() - e.at > TX_WINDOW) {
        e.status = 'failed';
        changed = true;
      }
    }
  }
  if (st.op) {
    const tx = st.op.hash ? await C.getTx(st.op.hash).catch(() => null) : null;
    if (tx?.blockNumber || Date.now() - st.op.at > TX_WINDOW) {
      st.op = null;
      changed = true;
    }
  }
  if (changed) saveState();
}

async function refreshGifts() {
  if (!st.address || !st.goals.length) return;
  const history = await C.getHistory(st.address, 200);
  const added = G.mergeGifts(st.goals, J.giftsFromHistory(history, st.address));
  if (added) {
    saveState();
    toast(tn('toast.gifts', added), 'good');
  }
}

async function refreshJail(staker) {
  R.jail = 0;
  if (!staker?.delegation || !staker.inactive) return;
  const v = await C.getValidator(staker.delegation);
  if (v?.jailedFrom) R.jail = v.jailedFrom + S.BLOCKS_PER_EPOCH * S.JAIL_EPOCHS + 1;
}

let lastGiftCheck = 0;

async function sync() {
  if (!st.address) return;
  if (R.syncing) {
    R.again = true;
    return;
  }
  R.syncing = true;
  try {
    const provider = W.getProvider();
    const [height, staker] = await Promise.all([
      provider ? provider.getBlockNumber().catch(() => C.getHeight()) : C.getHeight(),
      C.getStaker(st.address),
    ]);
    R.height = Number(height) || R.height;
    R.staker = staker;
    if (st.baseline === null) {
      st.baseline = staker ? staker.total : 0;
      saveState();
    }
    await Promise.all([checkPending(), refreshJail(staker).catch(() => {})]);
    await proveEarned().catch(() => {});
    finishWithdrawIfDone();
    noteRewards();
    if (!R.fresh && R.spendable === null) await quietWallet().catch(() => {});
    if (Date.now() - lastGiftCheck > 60e3) {
      lastGiftCheck = Date.now();
      await refreshGifts().catch(() => {});
    }
    R.online = true;
    R.syncedAt = Date.now();
  } catch {
    R.online = false;
  } finally {
    R.syncing = false;
    if (!sheetOpen() && !R.jar) render();
  }
  if (R.again) {
    R.again = false;
    await sync();
  }
}


/**
 * Read the deposits and withdrawals behind the stake from the chain and work out Earned. The stake is read again after
 * the history: if it moved in between, nothing is booked and the next sync tries again. A previous answer stays valid
 * while the stake is unchanged; otherwise a failed or partial read means "not known yet", never a guess.
 */
async function proveEarned(force = false) {
  if (!st.address || R.staker === undefined || hasPending()) return;
  const total = R.staker?.total ?? 0;
  const same = R.proven && R.proven.total === total && R.proven.owner === st.address;
  // A proven answer for an unchanged stake stays good for a while.
  if (!force && same && R.proven.earned !== null && Date.now() - R.proven.at < 10 * 60e3) return;
  // "Not known yet" is retried with a growing pause (30 s, 1, 2, 4 ... up to 10 min), never in a tight loop.
  if (!force && R.proveRetryAt && Date.now() < R.proveRetryAt) return;
  const keep = same && R.proven.earned !== null ? R.proven : null;
  const owner = st.address;
  try {
    const flowsOf = (txs, more) => RW.stakeFlows(txs, owner, [...st.accounts, ...more]);
    const { flows, keep: sums } = await C.stakeLedger(owner, st.accounts, st.stakeCache, flowsOf, C.readBudget());
    const again = await C.getStaker(owner);
    if ((again?.total ?? 0) !== total || st.address !== owner) return; // money moved, or the wallet changed, while reading
    if (Object.keys(sums).length) {
      st.stakeCache = Object.fromEntries(Object.entries({ ...st.stakeCache, ...sums }).slice(-60));
      saveState();
    }
    R.proven = { earned: RW.provenEarned(total, flows), net: Math.max(0, flows.deposits - flows.withdrawals), total, owner, at: Date.now() };
  } catch {
    R.proven = keep || { earned: null, net: R.proven?.net ?? 0, total, owner, at: Date.now() };
  }
  if (R.proven.earned === null) {
    R.proveFails = (R.proveFails || 0) + 1;
    R.proveRetryAt = Date.now() + Math.min(10 * 60e3, 30e3 * 2 ** (R.proveFails - 1));
  } else {
    R.proveFails = 0;
    R.proveRetryAt = 0;
  }
}

/** Book any rise in proven Earned as a reward that arrived, unless money is moving and the numbers may be mid-change. */
function noteRewards() {
  if (R.staker === undefined || !Number.isSafeInteger(R.proven?.earned)) return;
  const steady = !hasPending() && !st.unstake;
  const { rw, added } = RW.trackRewards(st.rewards, R.proven.earned, Date.now(), steady);
  if (rw === st.rewards) return;
  st.rewards = rw;
  saveState();
  if (added >= LUNA / 100) toast(t('toast.reward', { amount: nim(added) }), 'good', 5000);
}

/**
 * After a reopen, read the balance of the accounts the wallet listed last time. getBalance needs no approval
 * (Nimiq Pay's own docs, and its host code), so the wallet line is back without a Connect sheet. If the wallet has
 * moved to a new payment account since, the old one reads 0 and nothing is shown; the next Connect brings the new one.
 */
async function quietWallet() {
  if (R.fresh || !st.address || !st.accounts.length || st.accounts[0] !== st.address) return;
  const provider = W.getProvider();
  if (typeof provider?.getBalance !== 'function') return;
  const read = await W.walletBalances(st.accounts);
  if (R.fresh || read.spendable === null) return; // a Connect in the meantime has the newer answer
  R.wallet = read.total;
  R.spendable = read.spendable;
  R.walletComplete = read.complete;
}

async function loadExtras() {
  R.validators = await A.localValidators(R.network);
  const [fresh, market, stats] = await Promise.all([
    A.freshValidators(R.network), A.loadMarket(), A.loadStats(),
  ]);
  if (fresh) R.validators = fresh;
  R.market = market;
  R.stats = stats;
  if (!sheetOpen() && !R.jarSending) render();
}

/** The wallet's account list needs an approval, so it's only asked for when it's needed. */
async function connect() {
  const provider = W.getProvider();
  const accounts = await provider.listAccounts();
  const clean = (accounts || []).map(normalizeAddress).filter(Boolean);
  if (!clean.length) throw new Error('no accounts');
  R.accounts = clean;
  R.fresh = true;
  adoptAddress(clean[0]);
  st.accounts = clean;
  saveState();
  await readWallet();
  if (R.network === 'mainnet' && !DEMO && !st.seen && !st.noCount) {
    A.reportSeen(clean[0]).then(() => { st.seen = true; saveState(); }).catch(() => {});
  }
  return clean;
}

async function readWallet() {
  const { total, spendable, complete } = await W.walletBalances(R.accounts);
  R.wallet = total;
  R.spendable = spendable;
  R.walletComplete = complete;
}

/** Once money may have moved, the old balance can be wrong: unknown until it's read again. */
function forgetWallet() {
  R.wallet = null;
  R.spendable = null;
  R.walletComplete = false;
}

async function rereadWallet() {
  forgetWallet();
  if (R.fresh) await readWallet().catch(() => {});
}

async function ensureFresh() {
  if (R.fresh) {
    await readWallet().catch(() => {});
    return true;
  }
  try {
    await connect();
    return true;
  } catch (err) {
    if (W.classifyError(err) === 'cancel') toast(t('toast.cancel'));
    else toast(t('err.connect'), 'bad');
    return false;
  }
}

/** The wallet moved to a new payment account: keep the list current and read the balance again. */
function accountsChanged(list) {
  const clean = (Array.isArray(list) ? list : []).map(normalizeAddress).filter(Boolean);
  if (!clean.length || clean[0] !== st.address) return;
  st.accounts = clean;
  saveState();
  if (R.fresh) R.accounts = clean;
  forgetWallet();
  (R.fresh ? readWallet() : quietWallet()).catch(() => {}).finally(() => { if (!sheetOpen() && !R.jar) render(); });
}

/* ---------- wallet actions ---------- */

function walletFailure(err) {
  const kind = W.classifyError(err);
  if (kind === 'cancel') return toast(t('toast.cancel'));
  if (kind === 'unknown') return toast(t('err.unknown'), 'bad', 7000);
  if (kind === 'network') return toast(t('err.network'), 'bad', 6000);
  if (kind === 'unsupported') return toast(t('err.update'), 'bad', 6000);
  if (kind === 'invalid') return toast(t('err.invalid'), 'bad', 6000);
  if (kind === 'busy') return toast(t('err.busy'), 'bad', 6000);
  return toast(t('err.wallet'), 'bad', 6000);
}

async function settle(hash, goal) {
  const tx = await C.waitForTx(hash);
  await rereadWallet();
  await sync();
  if (!tx) {
    toast(t('toast.slow'), 'info', 6000);
    return null;
  }
  if (tx.executionResult === false) {
    toast(t('err.failedTx'), 'bad', 6000);
    return null;
  }
  if (goal) toast(t('toast.saved'), 'good');
  return tx;
}

/**
 * The wallet's co-signer can refuse a transaction the network wouldn't accept, and the wallet then waits on it
 * and blocks further sends. So every transaction is checked against the chain as it is now, right before asking.
 */
async function walletReady() {
  const ready = await W.getProvider().isConsensusEstablished().catch(() => false);
  if (!ready) toast(t('err.sync'), 'info', 5000);
  return ready;
}

async function preflightStake(value, pool) {
  const staker = await C.getStaker(st.address);
  R.staker = staker;
  await readWallet();
  if (R.spendable === null || value > R.spendable) return { ok: false, why: 'err.balance' };
  const { route } = S.saveRoute(value, staker);
  if (route === 'aside' || route === 'invalid') return { ok: false };
  const target = route === 'new' ? pool?.address : staker.delegation;
  if (target) {
    const validator = await C.getValidator(target);
    if (!validator || validator.retired) return { ok: false };
  }
  return { ok: true, route };
}

async function stakeFor(goal, value, fromWallet, wanted, pool) {
  const provider = W.getProvider();
  const entry = { kind: 'stake', luna: value, fromWallet, hash: null, at: Date.now(), status: 'pending' };
  let route = wanted;
  try {
    if (!(await walletReady())) return;
    const check = await preflightStake(value, pool);
    if (!check.ok) {
      toast(t(check.why || 'err.invalid'), 'bad', 6000);
      return;
    }
    route = check.route;
    if (route === 'new' && !pool) {
      toast(t('save.noPools'), 'bad', 6000);
      return;
    }
  } catch {
    toast(t('err.network'), 'bad', 6000);
    return;
  }
  try {
    entry.hash = route === 'new'
      ? await provider.sendNewStakerTransaction({ delegation: pool.address, value })
      : await provider.sendStakeTransaction({ value });
  } catch (err) {
    const kind = W.classifyError(err);
    if (kind === 'unknown' || kind === 'network') {
      entry.hash = W.errorHash(err);
      goal.entries.push(entry); // settled against the chain on the next sync; never send twice
      forgetWallet();
      saveState();
      closeSheet(true);
      render();
    }
    walletFailure(err);
    return;
  }
  if (route === 'new') st.validator = pool.address;
  goal.entries.push(entry);
  saveState();
  closeSheet(true);
  render();
  await settle(entry.hash, goal);
}

function setAside(goal, value) {
  goal.entries.push({ kind: 'aside', luna: value, at: Date.now(), status: 'ok' });
  saveState();
  closeSheet(true);
  toast(t('toast.aside'), 'good');
  render();
}

function noteUnknown(err, kind) {
  if (W.classifyError(err) === 'unknown') {
    st.op = { kind, hash: W.errorHash(err), at: Date.now() };
    saveState();
    closeSheet(true);
    render();
  }
}

/** Withdrawals act on the wallet's real account, so confirm it before working anything out. */
async function sameAccount() {
  const before = st.address;
  if (!(await ensureFresh())) return false;
  if (st.address === before) return true;
  closeSheet(true);
  render();
  return false;
}

async function startCooling(goal, amount) {
  const provider = W.getProvider();
  try {
    if (!(await sameAccount()) || !(await walletReady())) return;
    // Rewards may have landed since the sheet opened. What's left must be 0 or at least the network minimum.
    const staker = await C.getStaker(st.address);
    R.staker = staker;
    const rest = staker.active + staker.inactive - amount;
    const newActive = rest < S.MIN_STAKE ? 0 : rest;
    const hash = await provider.sendSetActiveStakeTransaction({ newActiveBalance: newActive });
    st.unstake = { goal: goal?.id || null, amount, at: Date.now() };
    st.op = { kind: 'cool', hash, at: Date.now() };
    saveState();
    closeSheet(true);
    render();
    if (await settle(hash)) toast(t('toast.cooling'), 'good');
  } catch (err) {
    noteUnknown(err, 'cool');
    walletFailure(err);
  }
}

async function stopCooling() {
  const provider = W.getProvider();
  try {
    if (!(await sameAccount()) || !(await walletReady())) return;
    const staker = await C.getStaker(st.address);
    R.staker = staker;
    const hash = await provider.sendSetActiveStakeTransaction({ newActiveBalance: staker.active + staker.inactive });
    st.unstake = null;
    st.op = { kind: 'uncool', hash, at: Date.now() };
    saveState();
    closeSheet(true);
    render();
    if (await settle(hash)) toast(t('toast.resumed'), 'good');
  } catch (err) {
    noteUnknown(err, 'uncool');
    walletFailure(err);
  }
}

async function retire(amount) {
  const provider = W.getProvider();
  const hash = await provider.sendRetireStakeTransaction({ retireStake: amount });
  st.op = { kind: 'retire', hash, at: Date.now() };
  saveState();
  render();
  const tx = await C.waitForTx(hash);
  await sync();
  if (!tx || tx.executionResult === false) throw Object.assign(new Error('retire'), { step: true });
}

async function remove(amount) {
  const provider = W.getProvider();
  const hash = await provider.sendRemoveStakeTransaction({ value: amount });
  st.op = { kind: 'remove', hash, at: Date.now() };
  st.unstake = { goal: st.unstake?.goal ?? null, amount: st.unstake?.amount ?? amount, at: st.unstake?.at ?? Date.now(), removing: amount };
  saveState();
  render();
  const tx = await C.waitForTx(hash);
  await rereadWallet();
  await sync();
  if (!tx) return toast(t('toast.slow'), 'info', 6000);
  if (tx.executionResult === false) return toast(t('err.failedTx'), 'bad', 6000);
  return toast(t('toast.withdrawn'), 'good');
}

/** Fresh chain state for the withdraw path, or null if it can't be read. */
async function freshStage() {
  const [height, staker] = await Promise.all([C.getHeight(), C.getStaker(st.address)]);
  R.height = height;
  R.staker = staker;
  await refreshJail(staker);
  return S.withdrawStage(staker, height, R.jail);
}

async function runRelease() {
  closeSheet(true);
  let kind = 'retire';
  try {
    if (!(await sameAccount()) || !(await walletReady())) return undefined;
    const stage = await freshStage();
    if (stage.stage === 'retire') {
      const plan = S.retirePlan(R.staker);
      if (!plan.amount) return render();
      await retire(plan.amount);
      kind = 'remove';
      const next = await freshStage();
      if (next.stage === 'remove') await remove(next.amount);
    } else if (stage.stage === 'remove') {
      kind = 'remove';
      await remove(stage.amount);
    } else {
      toast(t('cool.title'), 'info');
      render();
    }
  } catch (err) {
    if (err?.step) toast(t('err.failedTx'), 'bad', 6000);
    else {
      if (kind === 'remove') forgetWallet();
      noteUnknown(err, kind);
      walletFailure(err);
    }
  }
  return undefined;
}

/** Once retired stake has left, book it against the goal it came from. */
function finishWithdrawIfDone() {
  const u = st.unstake;
  if (!u?.removing || R.staker === undefined) return;
  if ((R.staker?.retired ?? 0) > 0 || st.op) return;
  const goal = u.goal ? findGoal(u.goal) : null;
  const out = u.removing;
  let rest = out;
  if (goal) {
    const inGoal = Math.min(G.parts(goal).stake, out);
    if (inGoal > 0) goal.entries.push({ kind: 'withdraw', luna: inGoal, at: Date.now(), status: 'ok' });
    rest -= inGoal;
  }
  // Anything beyond the goal's own deposits came from rewards first, then from stake older than Kuza.
  const before = G.earnedTotal((R.staker?.total ?? 0) + rest, st.baseline ?? 0, st.goals);
  const fromBaseline = Math.max(0, rest - before);
  if (fromBaseline) st.baseline = Math.max(0, (st.baseline ?? 0) - fromBaseline);
  st.unstake = null;
  saveState();
}

/* ---------- pieces of UI ---------- */

function chrome(body, { title, back, tools } = {}) {
  return h('div', { class: 'page' },
    R.network === 'testnet' ? h('div', { class: 'band test' }, t('band.testnet')) : null,
    DEMO ? h('div', { class: 'band demo' }, t('band.demo')) : null,
    h('header', { class: 'top' },
      back
        ? h('button', { class: 'icon-btn', 'aria-label': t('common.back'), 'data-rig': 'back', onclick: () => { location.hash = '#/'; } }, icon('back'))
        : h('div', { class: 'brand' }, logo(28), h('span', {}, 'Kuza')),
      title ? h('div', { class: 'top-title' }, title) : h('div', { class: 'grow' }),
      tools || h('button', { class: 'icon-btn', 'aria-label': t('settings.title'), 'data-rig': 'settings', onclick: sheetSettings }, icon('gear'))),
    !R.online ? h('div', { class: 'band warn' }, R.syncedAt ? t('band.offline', { time: when(R.syncedAt) }) : t('band.offlineNew')) : null,
    body);
}

function amountBlock(value, opts = {}) {
  const f = fiat(value);
  return h('div', { class: `amount ${opts.big ? 'big' : ''}` },
    h('div', { class: 'num' }, fmtNim(value, lang()), h('span', { class: 'unit' }, ' NIM')),
    f ? h('div', { class: 'fiat' }, `≈ ${f}`) : null);
}

function goalIcon(goal, size = 30) {
  return h('div', { class: 'gi' }, icon(goal.icon, size));
}

function coolingCard() {
  const stage = S.withdrawStage(R.staker, R.height ?? 0, R.jail);
  if (!['cooling', 'retire', 'remove'].includes(stage.stage)) return null;
  const goal = st.unstake?.goal ? findGoal(st.unstake.goal) : null;
  const text = stage.stage === 'cooling'
    ? t('cool.left', { amount: nim(stage.amount), time: hours(stage.blocksLeft) })
    : t('cool.ready', { amount: nim(stage.amount) });
  return h('button', { class: 'card notice', 'data-rig': 'cool-card', onclick: () => sheetWithdraw(goal) },
    h('div', { class: 'notice-i' }, icon('clock')),
    h('div', {}, h('b', {}, stage.stage === 'cooling' ? t('cool.title') : t('cool.readyTitle')), h('div', { class: 'small mute' }, text)));
}

function dueCards() {
  const now = Date.now();
  const out = [];
  for (const goal of openGoals()) {
    const due = G.dueNow(goal, now);
    if (!due) continue;
    const prog = goalProgress(goal);
    if (prog.left <= 0) continue;
    out.push(h('button', { class: 'card notice gold', 'data-rig': `due-${goal.id}`, onclick: () => sheetSave(goal) },
      h('div', { class: 'notice-i' }, icon('flame')),
      h('div', {},
        h('b', {}, t('due.title', { name: goal.name })),
        h('div', { class: 'small mute' }, t('due.body', { amount: nim(Math.min(due.left, prog.left)), date: day(due.endsAt) })))));
  }
  return out.slice(0, 2);
}

function summaryCard() {
  const staked = R.staker?.total ?? 0;
  const inWallet = notedInWallet();
  const pool = poolOf(R.staker?.delegation);
  const rate = pool && typeof pool.fee === 'number' ? rateText(pool.fee) : null; // after this pool's real fee, or not at all
  const last = RW.lastReward(st.rewards);
  return h('section', { class: 'hero' },
    h('div', { class: 'hero-label' }, t('home.staked')),
    R.staker === undefined ? h('div', { class: 'skeleton w60' }) : amountBlock(staked, { big: true }),
    h('div', { class: 'hero-row' },
      h('button', { class: 'hero-btn', 'data-rig': 'earned', 'aria-label': t('rw.title'), onclick: sheetRewards },
        h('div', { class: 'hero-k' }, t('home.earned'), ' ', icon('info', 12)), h('div', { class: 'hero-v', 'data-rig': 'earned-v' }, earnedLabel())),
      h('div', {}, h('div', { class: 'hero-k' }, t('home.inWallet')), h('div', { class: 'hero-v' }, nim(inWallet))),
      rate ? h('div', {}, h('div', { class: 'hero-k' }, t('home.rate')), h('div', { class: 'hero-v' }, `~${rate}`)) : null),
    pool ? h('div', { class: 'hero-foot' }, t('home.pool', { name: pool.name }),
      last ? ` · ${t('home.lastReward', { amount: nim(last.luna), date: shortDay(last.at) })}` : R.staker && R.proven?.earned === 0 ? ` · ${t('home.noReward')}` : '') : null);
}

const notedInWallet = () => openGoals().reduce((sum, g) => sum + G.parts(g).wallet, 0);

/** NIM in the wallet that could go toward a goal. Shown only from a balance read in this session, never a guessed 0. */
function walletCard() {
  const nudge = N.walletNudge({ spendable: R.spendable, noted: notedInWallet(), staker: R.staker, pending: hasPending() });
  if (!nudge) return null;
  const goals = openGoals();
  const target = goals.find((g) => goalProgress(g).left > 0) || null;
  const cta = target ? t('save.title', { name: target.name }) : goals.length ? t('home.new') : t('home.first');
  return h('button', { class: 'card notice gold nudge', 'data-rig': 'wallet-nudge', onclick: () => (target ? sheetSave(target, { suggest: true }) : sheetGoal()) },
    h('div', { class: 'notice-i' }, icon('seed')),
    h('div', { class: 'grow' },
      h('b', {}, nudge.more ? t('nudge.titleFree', { amount: nim(nudge.amount) }) : t('nudge.title', { amount: nim(nudge.amount) })),
      h('div', { class: 'small mute' }, nudge.canStake ? t('nudge.ready') : t('nudge.under')),
      h('div', { class: 'small link-ish nudge-cta' }, cta)),
    h('span', { class: 'notice-go' }, icon('next', 18)));
}

function goalCard(goal) {
  const prog = goalProgress(goal);
  const run = G.streak(goal, Date.now());
  const track = G.onTrack(goal, prog.saved, Date.now());
  const pending = goal.entries.some((e) => e.status === 'pending');
  const next = prog.ratio < 1 ? G.nextSave(goal, Date.now()) : null;
  return h('button', { class: 'card goal', 'data-rig': `goal-${goal.id}`, onclick: () => { location.hash = `#/goal/${goal.id}`; } },
    hexRing(prog.ratio, 74, h('div', { class: 'pct' }, `${Math.floor(prog.ratio * 100)}%`)),
    h('div', { class: 'goal-main' },
      h('div', { class: 'goal-name' }, icon(goal.icon, 18), h('span', {}, goal.name)),
      h('div', { class: 'small' }, t('goal.of', { saved: fmtNim(prog.saved, lang()), target: nim(goal.target) })),
      next ? h('div', { class: 'tiny mute', 'data-rig': 'next-line' }, next.done
        ? t(`plan.doneShort.${per(goal)}`)
        : t('plan.nextShort', { amount: nim(next.amount, 0), date: shortDay(next.by) })) : null,
      h('div', { class: 'chips' },
        pending ? h('span', { class: 'chip wait' }, t('goal.confirming')) : null,
        prog.ratio >= 1 ? h('span', { class: 'chip good' }, t('goal.reached')) : null,
        track && prog.ratio < 1 ? h('span', { class: `chip ${track.ok ? 'good' : 'warn'}` }, track.ok ? t('goal.onTrack') : t('goal.behind', { amount: nim(-track.delta, 0) })) : null,
        run > 0 ? h('span', { class: 'chip fire' }, icon('flame', 13), tn('goal.streak', run)) : null)));
}

function footer() {
  return h('footer', { class: 'foot' },
    R.stats?.wallets > 0 ? h('div', { 'data-rig': 'count' }, tn('foot.wallets', R.stats.wallets)) : null,
    h('a', { href: '#/how', 'data-rig': 'how' }, t('foot.how')));
}

/* ---------- screens ---------- */

function viewWelcome() {
  const rate = rateText(null); // before pool fees: no pool is chosen yet
  const point = (name, title, body) => h('li', {}, h('div', { class: 'wp-i' }, icon(name, 20)), h('div', {}, h('b', {}, title), h('p', { class: 'small mute' }, body)));
  let busy = false;
  const go = async (e) => {
    if (busy) return;
    busy = true;
    e.currentTarget.disabled = true;
    try {
      await connect();
      await sync();
    } catch (err) {
      if (W.classifyError(err) === 'cancel') toast(t('toast.cancelConnect'));
      else toast(t('err.connect'), 'bad');
    }
    busy = false;
    render();
  };
  return chrome(h('main', { class: 'welcome' },
    h('div', { class: 'welcome-mark' }, logo(84)),
    h('h1', {}, t('welcome.title')),
    h('p', { class: 'lead' }, t('welcome.sub')),
    h('ul', { class: 'wp' },
      point('seed', t('welcome.p1'), t('welcome.p1b')),
      point('flame', t('welcome.p2'), rate ? t('welcome.p2rate', { rate }) : t('welcome.p2b')),
      point('clock', t('welcome.p3'), t('welcome.p3b')),
      point('gift', t('welcome.p4'), t('welcome.p4b'))),
    h('button', { class: 'btn primary wide', 'data-rig': 'connect', onclick: go }, t('welcome.connect')),
    h('p', { class: 'tiny mute center' }, t('welcome.note')),
    footer()));
}

function viewHome() {
  const goals = openGoals();
  const body = h('main', {},
    summaryCard(),
    walletCard(),
    coolingCard(),
    dueCards(),
    h('div', { class: 'row-between' },
      h('h2', {}, t('home.goals')),
      goals.length ? h('button', { class: 'btn small ghost', 'data-rig': 'new-goal', onclick: () => sheetGoal() }, icon('plus', 16), t('home.new')) : null),
    goals.length
      ? goals.map(goalCard)
      : h('div', { class: 'card empty' },
        h('p', {}, t('home.empty')),
        h('div', { class: 'ideas' }, [t('idea.emergency'), t('idea.phone'), t('idea.school'), t('idea.trip')].map((name) => h('button', { class: 'chip-btn', onclick: () => sheetGoal(null, name) }, name))),
        h('button', { class: 'btn primary wide', 'data-rig': 'new-goal', onclick: () => sheetGoal() }, t('home.first'))),
    existingStakeNote(),
    doneGoals(),
    footer());
  return chrome(body);
}

/** Goals marked done stay on the phone as a small record. */
function doneGoals() {
  const done = st.goals.filter((g) => g.closedAt).sort((a, b) => b.closedAt - a.closedAt);
  if (!done.length) return null;
  return h('section', { class: 'card', 'data-rig': 'done-goals' },
    h('h3', {}, t('done.title')),
    done.slice(0, 10).map((g) => h('a', { class: 'entry done-row', href: `#/goal/${g.id}` },
      h('div', {}, h('div', { class: 'small' }, g.name), h('div', { class: 'tiny mute' }, t('done.when', { date: day(g.reachedAt || g.closedAt) }))),
      h('div', { class: 'entry-v' }, nim(g.target, 0)))));
}

function existingStakeNote() {
  const base = st.baseline ?? 0;
  if (!base || !openGoals().length) return null;
  return h('p', { class: 'small mute pad' }, t('home.existing', { amount: nim(base) }));
}

function viewGoal(goal) {
  if (!goal) {
    location.hash = '#/';
    return h('div');
  }
  const prog = goalProgress(goal);
  const now = Date.now();
  const reached = prog.ratio >= 1;
  const done = Boolean(goal.closedAt);
  const entries = [...goal.entries].sort((a, b) => b.at - a.at);
  const stakeable = !done && prog.wallet > 0 && S.saveRoute(prog.wallet, R.staker).route !== 'aside';
  const body = h('main', {},
    h('section', { class: 'goal-hero' },
      hexRing(prog.ratio, 164, h('div', {}, goalIcon(goal), h('div', { class: 'pct big' }, `${Math.floor(prog.ratio * 100)}%`)), { width: 6 }),
      h('h1', {}, goal.name),
      h('div', { class: 'mute' }, t('goal.of', { saved: fmtNim(prog.saved, lang()), target: nim(goal.target) })),
      fiat(goal.target) ? h('div', { class: 'tiny mute' }, `≈ ${fiat(prog.saved)} / ${fiat(goal.target)}`) : null,
      goal.date ? h('div', { class: 'tiny mute' }, t('goal.by', { date: dateText(goal.date) })) : null),
    markBanner(goal),
    done ? h('div', { class: 'card notice good', 'data-rig': 'done-card' }, h('div', { class: 'notice-i' }, icon('check')),
      h('div', { class: 'grow' }, h('b', {}, t('done.cardTitle')), h('div', { class: 'small mute' }, t('done.cardBody', { date: day(goal.closedAt) })))) : null,
    !done && reached ? reachedCard(goal) : null,
    coolingCard(),
    spentCard(goal, prog),
    h('div', { class: 'split' },
      h('div', { class: 'tile' }, h('div', { class: 'tile-k' }, t('goal.inStake')), h('div', { class: 'tile-v' }, nim(prog.stake))),
      h('button', { class: 'tile tile-btn', 'data-rig': 'goal-earned', onclick: sheetRewards }, h('div', { class: 'tile-k' }, t('goal.earned'), ' ', icon('info', 12)), h('div', { class: 'tile-v good', 'data-rig': 'goal-earned-v' }, Number.isSafeInteger(R.proven?.earned) ? `+${nim(prog.earned)}` : earnedLabel())),
      h('div', { class: 'tile' }, h('div', { class: 'tile-k' }, t('goal.inWallet')), h('div', { class: 'tile-v' }, nim(prog.wallet))),
      h('div', { class: 'tile' }, h('div', { class: 'tile-k' }, t('goal.gifts')), h('div', { class: 'tile-v' }, nim(prog.gifts)))),
    stakeable ? h('button', { class: 'card notice gold', 'data-rig': 'stake-wallet', onclick: () => sheetSave(goal, { includeWallet: true }) },
      h('div', { class: 'notice-i' }, icon('seed')),
      h('div', {}, h('b', {}, t('goal.moveTitle', { amount: nim(prog.wallet) })), h('div', { class: 'small mute' }, t('goal.moveBody')))) : null,
    done ? null : h('div', { class: 'actions' },
      h('button', { class: 'btn primary', 'data-rig': 'save', onclick: () => sheetSave(goal) }, icon('plus', 18), t('goal.save')),
      h('button', { class: 'btn', 'data-rig': 'share', onclick: () => sheetShare(goal) }, icon('share', 18), t('goal.share'))),
    !done && !R.fresh && st.address ? h('p', { class: 'tiny mute center', 'data-rig': 'connect-note' }, t('goal.connectNote')) : null,
    !done && !reached ? inviteNudge(goal, prog) : null,
    !done ? planCard(goal, prog, now) : null,
    h('section', { class: 'card' },
      h('h3', {}, t('goal.activity')),
      entries.length ? entries.slice(0, 30).map(entryRow) : h('p', { class: 'small mute' }, t('goal.noActivity'))),
    h('div', { class: 'links' },
      done
        ? h('button', { class: 'link', 'data-rig': 'reopen', onclick: () => { goal.closedAt = null; saveState(); render(); } }, t('done.reopen'))
        : h('button', { class: 'link', 'data-rig': 'edit', onclick: () => sheetGoal(goal) }, t('goal.edit')),
      prog.stake > 0 || (R.staker?.inactive ?? 0) > 0
        ? h('button', { class: 'link danger', 'data-rig': 'break', onclick: () => sheetWithdraw(goal) }, reached ? t('goal.takeOut') : t('goal.break'))
        : h('button', { class: 'link danger', 'data-rig': 'delete', onclick: () => sheetDelete(goal) }, t('goal.delete'))));
  return chrome(body, { back: true, title: goal.name, tools: h('span', { class: 'icon-spacer' }) });
}

/** The 25 / 50 / 75% moment, shown on the goal until the user leaves it. */
function markBanner(goal) {
  if (!R.banner || R.banner.id !== goal.id) return null;
  return h('div', { class: 'card notice gold mark', 'data-rig': 'mark-banner', role: 'status' },
    h('div', { class: 'notice-i' }, icon('flame')),
    h('div', { class: 'grow' }, h('b', {}, t(`mark.${R.banner.mark}`)), h('div', { class: 'small mute' }, t('mark.body', { name: goal.name }))));
}

function reachedCard(goal) {
  return h('section', { class: 'card notice good reached', 'data-rig': 'reached-card' },
    h('div', { class: 'notice-i' }, icon('check')),
    h('div', { class: 'grow' },
      h('b', {}, t('goal.doneTitle')),
      h('div', { class: 'small mute' }, t('reached.cardBody')),
      h('div', { class: 'reached-acts' },
        h('button', { class: 'btn small', 'data-rig': 'r-next', onclick: () => sheetGoal(null, '', { from: goal }) }, t('reached.next')),
        h('button', { class: 'btn small', 'data-rig': 'r-use', onclick: () => sheetUse(goal) }, t('reached.use')),
        h('button', { class: 'btn small ghost', 'data-rig': 'r-keep', onclick: () => sheetGoal(goal) }, t('reached.raise')))));
}

/** Once a goal's stake is back in the wallet: spend it, or mark the goal done. */
function spentCard(goal, prog) {
  const back = goal.entries.some((e) => e.kind === 'withdraw' && e.status === 'ok');
  const out = R.staker && (R.staker.inactive > 0 || R.staker.retired > 0);
  if (!back || prog.stake > 0 || out || goal.closedAt) return null;
  return h('section', { class: 'card notice gold', 'data-rig': 'spend-card' },
    h('div', { class: 'notice-i' }, icon('bolt')),
    h('div', { class: 'grow' },
      h('b', {}, t('spend.backTitle')),
      h('div', { class: 'small mute' }, t('spend.backBody')),
      h('div', { class: 'reached-acts' },
        h('button', { class: 'btn small', 'data-rig': 'spend-pay', onclick: () => sheetPayInvoice(goal) }, icon('bolt', 16), t('spend.pay')),
        h('button', { class: 'btn small ghost', 'data-rig': 'spend-done', onclick: () => markDone(goal) }, t('spend.markDone')))));
}

function inviteNudge(goal, prog) {
  if (prog.gifts > 0 || goal.sharedAt) return null;
  if (!goal.entries.some((e) => e.status === 'ok')) return null;
  return h('button', { class: 'card notice', 'data-rig': 'invite-nudge', onclick: () => sheetShare(goal) },
    h('div', { class: 'notice-i' }, icon('gift')),
    h('div', { class: 'grow' }, h('b', {}, t('invite.nudgeTitle')), h('div', { class: 'small mute' }, t('invite.nudgeBody', { name: goal.name }))),
    h('span', { class: 'notice-go' }, icon('next', 18)));
}

/** The savings plan: next saving, on plan or not, when the goal lands at this pace, and the last periods. */
function planCard(goal, prog, now) {
  if (!goal.weekly) {
    if (prog.ratio >= 1) return null;
    return h('button', { class: 'card notice', 'data-rig': 'plan-add', onclick: () => sheetGoal(goal) },
      h('div', { class: 'notice-i' }, icon('clock')),
      h('div', { class: 'grow' }, h('b', {}, t('plan.addTitle')), h('div', { class: 'small mute' }, t('plan.addBody'))),
      h('span', { class: 'notice-go' }, icon('next', 18)));
  }
  const p = per(goal);
  const run = G.streak(goal, now);
  const reached = prog.ratio >= 1;
  const next = reached ? null : G.nextSave(goal, now);
  const status = reached ? null : G.planStatus(goal, prog.saved, now);
  const finish = reached ? null : G.projectFinish(goal, prog.left, now);
  const dateEnd = goal.date ? Date.parse(`${goal.date}T23:59:59Z`) : null;
  const late = finish && dateEnd && finish.at > dateEnd;
  const fix = late ? G.suggestPlan(goal.target, goal.date, now, goal.every, prog.saved) : null;
  const strip = G.weekStrip(goal, now, 8);
  const rows = [];
  if (next) {
    rows.push(h('div', { class: 'plan-row', 'data-rig': 'plan-next' },
      h('span', { class: 'plan-k' }, t('plan.next')),
      h('b', {}, next.done ? t(`plan.nextDone.${p}`, { amount: nim(next.amount, 0), date: shortDay(next.from) }) : t('plan.nextDue', { amount: nim(next.amount, 0), date: shortDay(next.by) }))));
  }
  if (status) {
    const word = status.ok ? (status.delta > goal.weekly / 4 ? t('plan.ahead', { amount: nim(status.delta, 0) }) : t('goal.onTrack')) : t('goal.behind', { amount: nim(-status.delta, 0) });
    rows.push(h('div', { class: 'plan-row', 'data-rig': 'plan-status' },
      h('span', { class: 'plan-k' }, status.by === 'date' ? t('plan.byDate') : t('plan.byPlan')),
      h('span', { class: `chip ${status.ok ? 'good' : 'warn'}` }, word)));
  }
  if (finish) {
    rows.push(h('div', { class: 'plan-row', 'data-rig': 'plan-finish' },
      h('span', { class: 'plan-k' }, t('plan.pace')),
      h('b', {}, day(finish.at))));
  }
  return h('section', { class: 'card plan', 'data-rig': 'plan-card' },
    h('div', { class: 'row-between' },
      h('b', {}, t(`plan.title.${p}`, { amount: nim(goal.weekly, 0) })),
      run ? h('span', { class: 'chip fire', 'data-rig': 'streak' }, icon('flame', 13), tn(`plan.streak.${p}`, run)) : null),
    rows,
    late && fix?.amount ? h('p', { class: 'tiny warn', 'data-rig': 'plan-late' }, t(`plan.late.${p}`, { amount: nim(fix.amount, 0) })) : null,
    h('div', { class: 'weeks', 'aria-hidden': 'true' }, strip.map((w) => h('span', { class: `wk ${w.met ? 'met' : ''} ${w.current ? 'now' : ''}`, title: nim(w.amount) }))),
    h('p', { class: 'tiny mute' }, t(`plan.stripNote.${p}`)));
}

function markDone(goal) {
  goal.closedAt = Date.now();
  if (!goal.reachedAt && goalProgress(goal).ratio >= 1) goal.reachedAt = goal.closedAt;
  saveState();
  closeSheet(true);
  toast(t('toast.done'), 'good');
  location.hash = '#/';
  render();
}

function entryRow(e) {
  const label = {
    aside: t('entry.aside'), gift: e.note ? t('entry.giftNote', { note: e.note }) : t('entry.gift'), stake: t('entry.stake'),
    assign: e.ref ? t('entry.movedIn', { name: e.ref }) : t('entry.assign'), withdraw: t('entry.withdraw'),
    move: t('entry.movedOut', { name: e.ref || '' }),
    spend: e.sats ? t('entry.spendSats', { sats: fmtSats(e.sats) }) : t('entry.spend'),
  }[e.kind] || e.kind;
  if (e.kind === 'spend') {
    return h('div', { class: 'entry spend' },
      h('div', {}, h('div', { class: 'small' }, label), h('div', { class: 'tiny mute' }, day(e.at))),
      h('div', { class: 'entry-v' }, e.luna ? `−${nim(e.luna)}` : '',
        e.hash ? h('a', { class: 'tiny', href: C.explorerTx(e.hash), target: '_blank', rel: 'noopener noreferrer' }, t('entry.proof')) : null));
  }
  const sign = e.kind === 'withdraw' || e.kind === 'move' ? '−' : '+';
  const status = e.status === 'pending' ? t('entry.pending') : e.status === 'failed' ? t('entry.failed') : '';
  return h('div', { class: `entry ${e.status}` },
    h('div', {},
      h('div', { class: 'small' }, label),
      h('div', { class: 'tiny mute' }, day(e.at), e.kind === 'gift' && e.from ? ` · ${shortAddress(e.from)}` : '', status ? ` · ${status}` : '')),
    h('div', { class: 'entry-v' }, `${sign}${nim(e.luna)}`,
      e.hash ? h('a', { class: 'tiny', href: C.explorerTx(e.hash), target: '_blank', rel: 'noopener noreferrer' }, t('entry.proof')) : null));
}

function viewHow() {
  const start = R.height ? S.releaseIfStartedAt(R.height, R.network) : null;
  const rate = rateLine();
  const blk = (title, ...paras) => h('section', { class: 'card' }, h('h3', {}, title), paras.filter(Boolean).map((p) => h('p', { class: 'small' }, p)));
  return chrome(h('main', {},
    blk(t('how.q1'), t('how.a1')),
    blk(t('how.q2'), t('how.a2'), start ? t('how.a2live', { time: hours(start - R.height), date: when(Date.now() + S.blocksToMs(start - R.height)) }) : null),
    blk(t('how.q3'), t('how.a3'), rate),
    blk(t('how.q4'), t('how.a4')),
    blk(t('how.q5'), t('how.a5')),
    blk(t('how.q6'), t('how.a6')),
    blk(t('how.q8'), t('how.a8')),
    blk(t('how.q7'), t('how.a7')),
    h('p', { class: 'center small' }, h('a', { href: REPO, target: '_blank', rel: 'noopener noreferrer' }, t('how.code')))), { back: true, title: t('how.title'), tools: h('span', { class: 'icon-spacer' }) });
}

/* ---------- sheets ---------- */

function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-k' }, label), input, hint || null);
}

/**
 * New goal or edit. With `from` (a reached goal) it's the next goal: its stake can be handed over to the new one,
 * which needs no transaction, because the NIM stays where it is, in the user's own stake.
 */
function sheetGoal(goal = null, presetName = '', { from = null } = {}) {
  const now = Date.now();
  let icn = goal?.icon || 'seed';
  let every = goal?.every === 'month' ? 'month' : 'week';
  const name = h('input', { type: 'text', maxlength: 40, value: goal?.name || presetName, placeholder: t('form.namePh'), autocomplete: 'off', 'data-rig': 'f-name' });
  const target = h('input', { type: 'text', inputmode: 'decimal', value: goal ? plainNim(goal.target) : '', placeholder: '50000', autocomplete: 'off', 'data-rig': 'f-target' });
  const date = h('input', { type: 'date', value: goal?.date || '', min: new Date(now + 864e5).toISOString().slice(0, 10), 'data-rig': 'f-date' });
  const weekly = h('input', { type: 'text', inputmode: 'decimal', value: goal?.weekly ? plainNim(goal.weekly) : '', placeholder: '0', autocomplete: 'off', 'data-rig': 'f-weekly' });
  const hint = h('p', { class: 'tiny mute', 'data-rig': 'f-hint' });
  const err = h('p', { class: 'tiny bad' });
  const carry = from ? G.parts(from).stake : 0;
  const move = carry > 0 ? h('input', { type: 'checkbox', checked: true, 'data-rig': 'f-move' }) : null;
  let touched = Boolean(goal?.weekly);
  weekly.addEventListener('input', () => { touched = true; });
  const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': t('form.every') });
  const already = goal ? goalProgress(goal).saved : 0;
  const update = () => {
    const luna = toLuna(target.value);
    const f = luna ? fiat(luna) : '';
    const sug = luna && date.value ? G.suggestPlan(luna, date.value, now, every, already + (move?.checked ? carry : 0)) : { amount: 0, periods: 0 };
    if (sug.amount && !touched) weekly.value = String(Math.ceil(sug.amount / LUNA));
    hint.textContent = [f ? `≈ ${f}` : '', sug.amount ? t(`form.suggest.${every}`, { amount: nim(sug.amount, 0), n: sug.periods }) : ''].filter(Boolean).join(' · ');
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.every === every)));
  };
  for (const [key, label] of [['week', t('form.everyWeek')], ['month', t('form.everyMonth')]]) {
    seg.append(h('button', { type: 'button', role: 'radio', 'data-every': key, 'data-rig': `f-every-${key}`, onclick: () => { every = key; update(); } }, label));
  }
  target.addEventListener('input', update);
  date.addEventListener('change', update);
  move?.addEventListener('change', update);
  const picks = h('div', { class: 'icons' }, GOAL_ICONS.map((name2) => h('button', { type: 'button', class: `pick ${name2 === icn ? 'on' : ''}`, 'aria-label': name2, onclick: (e) => { icn = name2; picks.querySelectorAll('.pick').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); } }, icon(name2))));
  const submit = () => {
    const cleanName = J.cleanName(name.value);
    const luna = toLuna(target.value);
    const weeklyLuna = weekly.value.trim() ? toLuna(weekly.value) : 0;
    if (J.URLISH.test(J.cleanText(name.value, 40))) { err.textContent = t('form.errNameLink'); return; }
    if (!cleanName) { err.textContent = t('form.errName'); return; }
    if (!luna || luna < LUNA) { err.textContent = t('form.errTarget'); return; }
    if (weeklyLuna === null) { err.textContent = t('form.errWeekly'); return; }
    if (date.value && Number.isNaN(Date.parse(date.value))) { err.textContent = t('form.errDate'); return; }
    if (goal) {
      Object.assign(goal, { name: cleanName, target: luna, date: date.value || null, weekly: weeklyLuna, every, icon: icn });
      // A raised target means the goal isn't reached any more: its 100% can be celebrated again later.
      if (goalProgress(goal).ratio < 1 && Array.isArray(goal.marks)) goal.marks = goal.marks.filter((m) => m < 100);
      saveState();
      closeSheet(true);
      render();
      return;
    }
    const fresh = G.newGoal({ id: newId(), name: cleanName, target: luna, date: date.value || null, weekly: weeklyLuna, every, icon: icn, now });
    st.goals.push(fresh);
    if (from && move?.checked && carry > 0) {
      // The stake stays exactly where it is; only which goal it counts toward changes.
      from.entries.push({ kind: 'move', luna: carry, at: now, status: 'ok', ref: cleanName });
      fresh.entries.push({ kind: 'assign', luna: carry, at: now, status: 'ok', ref: from.name });
      from.closedAt = now;
      if (!from.reachedAt) from.reachedAt = now;
      fresh.marks = G.passedMarks(goalProgress(fresh).ratio);
      saveState();
      closeSheet(true);
      location.hash = `#/goal/${fresh.id}`;
      toast(t('toast.moved', { amount: nim(carry), name: cleanName }), 'good', 5000);
      return;
    }
    saveState();
    closeSheet(true);
    location.hash = `#/goal/${fresh.id}`;
    sheetSave(fresh, { first: true });
  };
  const form = h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); submit(); } },
    from ? h('p', { class: 'small good' }, t('form.nextIntro', { name: from.name })) : null,
    field(t('form.name'), name),
    h('div', { class: 'icons-wrap' }, picks),
    field(t('form.target'), target),
    field(t('form.date'), date),
    h('div', { class: 'field' }, h('span', { class: 'field-k' }, t('form.plan')), h('div', { class: 'plan-in' }, weekly, seg)),
    hint,
    move ? h('label', { class: 'toggle' }, move, h('span', { class: 'small' }, t('form.move', { amount: nim(carry), name: from.name }))) : null,
    err,
    h('button', { class: 'btn primary wide', type: 'submit', 'data-rig': 'f-submit' }, goal ? t('form.saveEdit') : t('form.create')));
  openSheet(goal ? t('form.editTitle') : from ? t('form.nextTitle') : t('form.newTitle'), form);
  update();
  if (!goal) name.focus();
}

function sheetDelete(goal) {
  const prog = G.parts(goal);
  openSheet(t('del.title'), h('div', { class: 'form' },
    h('p', { class: 'small' }, prog.wallet > 0 ? t('del.bodyWallet', { amount: nim(prog.wallet) }) : t('del.body')),
    h('button', { class: 'btn danger wide', 'data-rig': 'del-yes', onclick: () => { st.goals = st.goals.filter((g) => g !== goal); saveState(); closeSheet(true); location.hash = '#/'; render(); } }, t('del.yes')),
    h('button', { class: 'btn wide', onclick: () => closeSheet() }, t('common.keep'))));
}

const hasPending = () => Boolean(st.op) || st.goals.some((g) => g.entries.some((e) => e.status === 'pending'));

async function sheetSave(goal, { includeWallet = false, first = false, suggest = false, typed: keep = null } = {}) {
  if (hasPending()) {
    sync();
    toast(t('wd.waitOp'));
    return;
  }
  if (!(await ensureFresh())) return;
  const wallet = G.parts(goal).wallet;
  let useWallet = includeWallet || (first && wallet > 0);
  const prog = goalProgress(goal);
  const due = G.dueNow(goal, Date.now());
  const preset = includeWallet ? 0 : (due?.left ?? 0);
  // Nothing staked yet: fill in what the wallet can spare, as a suggestion the user edits. Never more than the balance.
  const suggested = (first || suggest) && !includeWallet && keep === null
    ? N.firstSuggestion({ spendable: R.spendable, noted: notedInWallet(), staker: R.staker, left: prog.left })
    : 0;
  const start = keep ?? (suggested ? plainNim(suggested) : preset ? String(Math.ceil(preset / LUNA)) : '');
  const amount = h('input', { type: 'text', inputmode: 'decimal', value: start, placeholder: '0', autocomplete: 'off', 'data-rig': 's-amount' });
  const suggestNote = suggested ? h('p', { class: 'tiny mute', 'data-rig': 's-suggested' }, t('save.suggested', { amount: nim(R.spendable) })) : null;
  const info = h('div', { class: 'route' });
  const fiatLine = h('p', { class: 'tiny mute' });
  const btn = h('button', { class: 'btn primary wide', 'data-rig': 's-submit' }, t('save.go'));
  let pool = bestPool();
  let plan = null;

  const render2 = () => {
    pool = pool || bestPool();
    const typed = amount.value.trim() ? toLuna(amount.value) : 0;
    const part = useWallet ? wallet : 0;
    const value = typed === null ? null : typed + part;
    const route = value ? S.saveRoute(value, R.staker) : { route: 'invalid' };
    const staked = route.route === 'new' || route.route === 'add';
    const newMoney = typed || 0;
    const noted = notedInWallet();
    const tooMuch = R.spendable !== null && staked && value > R.spendable;
    plan = { value, part, route: route.route };
    fiatLine.textContent = value && fiat(value) ? `≈ ${fiat(value)}` : '';
    const kids = [];
    if (route.route === 'new') {
      kids.push(h('p', { class: 'small' }, t('save.routeNew')));
      kids.push(poolRow(pool, () => {
        const typedNow = amount.value;
        sheetPools((p) => {
          st.validator = p.address;
          saveState();
          sheetSave(goal, { includeWallet: useWallet, typed: typedNow });
        });
      }));
    } else if (route.route === 'add') {
      const name = poolOf(R.staker?.delegation)?.name;
      kids.push(h('p', { class: 'small' }, name ? t('save.routeAddPool', { name }) : t('save.routeAdd')));
    } else if (route.route === 'aside') {
      kids.push(h('p', { class: 'small' }, t('save.routeAside', { amount: nim(route.short) })));
    } else if (typed === null) {
      kids.push(h('p', { class: 'tiny bad' }, t('form.errAmount')));
    } else {
      kids.push(h('p', { class: 'small mute' }, t('save.hint')));
    }
    if (tooMuch) kids.push(h('p', { class: 'tiny bad' }, t('save.tooMuch', { amount: nim(R.spendable) })));
    if (tooMuch && R.wallet > R.spendable) kids.push(h('p', { class: 'tiny mute' }, t('save.arriving', { amount: nim(R.wallet - R.spendable) })));
    if (suggestNote) suggestNote.hidden = amount.value !== start;
    if (R.wallet === 0 && R.walletComplete) kids.push(h('p', { class: 'tiny warn' }, t('save.empty')));
    else if (route.route === 'aside' && R.walletComplete && newMoney + noted > R.wallet) kids.push(h('p', { class: 'tiny warn' }, t('save.asideOver', { amount: nim(R.wallet) })));
    info.replaceChildren(...kids);
    btn.disabled = !value || route.route === 'invalid' || tooMuch || (route.route === 'new' && !pool);
    btn.textContent = route.route === 'aside' ? t('save.goAside', { amount: nim(newMoney, 5) }) : staked ? t('save.goStake', { amount: nim(value, 5) }) : t('save.go');
  };

  amount.addEventListener('input', render2);
  let sending = false;
  btn.addEventListener('click', async () => {
    if (sending || !plan?.value) return;
    sending = true;
    btn.disabled = true;
    btn.textContent = t('save.waiting');
    if (plan.route === 'aside') {
      if (plan.value - plan.part > 0) setAside(goal, plan.value - plan.part);
      else closeSheet();
    } else {
      await stakeFor(goal, plan.value, plan.part, plan.route, plan.route === 'new' ? pool : null);
    }
    sending = false;
    if (sheetOpen()) render2();
  });

  const chips = [];
  if (due?.left) chips.push([t('save.chipPlan'), due.left]);
  chips.push(['100', 100 * LUNA], ['1,000', 1000 * LUNA]);
  if (prog.left > 0) chips.push([t('save.chipRest'), prog.left]);

  const walletToggle = wallet > 0 ? h('label', { class: 'toggle' },
    h('input', { type: 'checkbox', checked: useWallet, 'data-rig': 's-wallet', onchange: (e) => { useWallet = e.target.checked; render2(); } }),
    h('span', { class: 'small' }, t('save.useWallet', { amount: nim(wallet) }))) : null;

  const base = st.baseline ?? 0;
  const assign = base > 0 ? h('button', { class: 'link', 'data-rig': 's-assign', onclick: () => assignExisting(goal) }, t('save.assign', { amount: nim(base) })) : null;

  openSheet(t('save.title', { name: goal.name }), h('div', { class: 'form' },
    first ? h('p', { class: 'small good' }, t('save.first')) : null,
    field(t('save.amount'), amount),
    suggestNote,
    fiatLine,
    h('div', { class: 'quick' }, chips.map(([label, luna]) => h('button', { type: 'button', class: 'chip-btn', onclick: () => { amount.value = String(Math.ceil(luna / LUNA)); render2(); } }, label))),
    walletToggle,
    info,
    R.spendable !== null ? h('p', { class: 'tiny mute' }, t('save.wallet', { amount: nim(R.spendable) })) : null,
    btn,
    assign,
    h('p', { class: 'tiny mute center' }, t('save.foot'))));
  render2();
}

function assignExisting(goal) {
  const base = st.baseline ?? 0;
  const take = Math.min(base, Math.max(0, goal.target - G.parts(goal).stake));
  if (!take) return;
  goal.entries.push({ kind: 'assign', luna: take, at: Date.now(), status: 'ok' });
  st.baseline = base - take;
  saveState();
  closeSheet(true);
  render();
  toast(t('toast.assigned'), 'good');
}

function poolRow(pool, onPick) {
  if (!pool) return h('p', { class: 'tiny bad' }, t('save.noPools'));
  return h('button', { type: 'button', class: 'pool', 'data-rig': 's-pool', onclick: onPick },
    h('span', { class: 'pool-dot', style: `background:${pool.color}` }, pool.name.slice(0, 1)),
    h('span', { class: 'pool-main' }, h('b', {}, pool.name),
      h('span', { class: 'tiny mute' }, pool.fee !== null ? t('pool.fee', { fee: fmtPct(pool.fee) }) : '')),
    h('span', { class: 'tiny link-ish' }, t('pool.change')));
}

const fmtSats = (n) => new Intl.NumberFormat(lang(), { maximumFractionDigits: 3 }).format(n);

const fmtPct = (x) => new Intl.NumberFormat(lang(), { style: 'percent', maximumFractionDigits: 2 }).format(x);

function sheetPools(onPick) {
  openSheet(t('pool.title'), h('div', { class: 'form' },
    h('p', { class: 'small mute' }, t('pool.body')),
    R.validators.slice(0, 8).map((v) => h('button', { class: 'pool', onclick: () => onPick(v) },
      h('span', { class: 'pool-dot', style: `background:${v.color}` }, v.name.slice(0, 1)),
      h('span', { class: 'pool-main' }, h('b', {}, v.name),
        h('span', { class: 'tiny mute' }, [v.fee !== null ? t('pool.fee', { fee: fmtPct(v.fee) }) : '', v.schedule].filter(Boolean).join(' · ')))))));
}

/** A QR code as inline SVG (no image request, nothing for the content policy to allow). */
function qrBox(text, size = 232) {
  const { d, size: n } = qrPath(qrMatrix(text));
  return h('div', { class: 'qr', 'data-rig': 'qr' },
    svg('svg', { viewBox: `0 0 ${n} ${n}`, width: size, height: size, role: 'img', 'aria-label': t('qr.label'), 'shape-rendering': 'crispEdges' },
      svg('rect', { width: n, height: n, fill: '#fff' }),
      svg('path', { d, fill: '#1f2348' })));
}

function sheetQR(link, title, body) {
  openSheet(title, h('div', { class: 'form center' },
    qrBox(link),
    h('p', { class: 'small' }, body),
    h('code', { class: 'mono', 'data-rig': 'qr-link' }, link),
    h('button', { class: 'btn wide', onclick: () => closeSheet() }, t('common.ok'))));
}

function sheetShare(goal) {
  const link = I.inviteLink(goal, st.address, R.network);
  if (!J.decodeInvite(new URL(link).searchParams.get('j'))) {
    openSheet(t('share.title'), h('div', { class: 'form' },
      h('p', { class: 'small warn', 'data-rig': 'share-badname' }, t('share.badName')),
      h('button', { class: 'btn primary wide', onclick: () => sheetGoal(goal) }, t('goal.edit'))));
    return;
  }
  const message = t('share.msg', { name: goal.name, link });
  const prog = goalProgress(goal);
  const shared = () => {
    if (!goal.sharedAt) {
      goal.sharedAt = Date.now();
      saveState();
      render(); // the "ask friends" card under the sheet has done its job
    }
  };
  const box = h('input', { type: 'text', readonly: true, value: link, onclick: (e) => e.target.select(), 'data-rig': 'share-link' });
  const copy = async (text, done) => {
    const ok = await copyText(text);
    toast(ok ? done : t('share.select'), ok ? 'good' : 'info', 4200);
    if (ok) shared();
    else box.select();
  };
  // The phone's own share sheet where the browser offers one (not inside every wallet's web view), else copy.
  const canShare = typeof navigator.share === 'function';
  const main = canShare
    ? h('button', { class: 'btn primary wide', 'data-rig': 'share-native', onclick: () => navigator.share({ title: goal.name, text: t('share.msgShort', { name: goal.name }), url: link }).then(shared, () => {}) }, icon('share', 18), t('share.system'))
    : h('button', { class: 'btn primary wide', 'data-rig': 'share-copy-msg', onclick: () => copy(message, t('share.copiedMsg')) }, icon('share', 18), t('share.copyMsg'));
  openSheet(t('share.title'), h('div', { class: 'form' },
    h('div', { class: 'invite-card', 'data-rig': 'share-preview', 'aria-label': t('share.previewLabel') },
      hexRing(prog.ratio, 58, h('div', { class: 'gi' }, icon('gift', 20)), { width: 8 }),
      h('div', { class: 'grow' },
        h('div', { class: 'tiny mute' }, t('share.previewKicker')),
        h('b', {}, goal.name),
        h('div', { class: 'tiny mute' }, t('goal.of', { saved: fmtNim(prog.saved, lang()), target: nim(goal.target) })))),
    h('p', { class: 'small' }, t('share.body')),
    main,
    h('div', { class: 'actions' },
      h('button', { class: 'btn', 'data-rig': 'share-copy', onclick: () => copy(link, t('share.copied')) }, icon('link', 18), t('share.copy')),
      h('button', { class: 'btn', 'data-rig': 'share-qr', onclick: () => { shared(); sheetQR(link, t('qr.title'), t('qr.body')); } }, icon('qr', 18), t('share.qr'))),
    field(t('share.link'), box),
    canShare ? h('button', { class: 'link', 'data-rig': 'share-copy-msg', onclick: () => copy(message, t('share.copiedMsg')) }, t('share.copyMsg')) : null,
    h('p', { class: 'tiny mute' }, t('share.note', { address: shortAddress(st.address) }))));
}

/** How rewards reach the stake, and what Kuza has seen arrive. Everything here is read from the chain or this phone. */
function sheetRewards() {
  const pool = poolOf(R.staker?.delegation);
  const rate = rateLine();
  const events = [...(st.rewards?.events || [])].reverse();
  const proven = R.proven?.earned;
  const total = Number.isSafeInteger(proven) ? proven : 0;
  openSheet(t('rw.title'), h('div', { class: 'form', 'data-rig': 'rewards-sheet' },
    h('div', { class: 'rw-total', 'data-rig': 'rw-total' }, h('div', { class: 'tiny mute' }, t('rw.total')),
      Number.isSafeInteger(proven) ? amountBlock(total) : h('div', { class: 'num-unknown' }, earnedLabel())),
    proven === null ? h('p', { class: 'small warn', 'data-rig': 'rw-unknown' }, t('rw.unknown')) : null,
    events.length
      ? h('section', {}, h('h3', {}, t('rw.seen')), events.slice(0, 8).map((e) => h('div', { class: 'entry' },
        h('div', {}, h('div', { class: 'small' }, t('rw.event')), h('div', { class: 'tiny mute' }, when(e.at))),
        h('div', { class: 'entry-v good' }, `+${nim(e.luna)}`))))
      : proven === null ? null : h('p', { class: 'small', 'data-rig': 'rw-none' }, !R.staker ? t('rw.noStake') : total > 0 ? t('rw.earlier') : t('rw.none')),
    pool ? h('div', { class: 'route' },
      h('p', { class: 'small' }, h('b', {}, pool.name), ' · ', pool.fee !== null ? t('pool.fee', { fee: fmtPct(pool.fee) }) : ''),
      h('p', { class: 'tiny mute' }, pool.schedule ? t('rw.schedule', { schedule: pool.schedule }) : t('rw.scheduleOwn'))) : null,
    h('p', { class: 'small' }, t('rw.how1')),
    h('p', { class: 'small' }, t('rw.how2')),
    rate ? h('p', { class: 'tiny mute', 'data-rig': 'rw-rate' }, rate) : null,
    st.rewards?.since ? h('p', { class: 'tiny mute' }, t('rw.since', { date: day(st.rewards.since) })) : null,
    h('button', { class: 'btn wide', onclick: () => closeSheet() }, t('common.ok'))));
}

/** A goal hit 100%: say so once, with what got it there, and offer the three ways on. */
function sheetReached(goal) {
  const prog = goalProgress(goal);
  const days = (Date.now() - goal.createdAt) / 864e5;
  const row = (k, v) => h('div', { class: 'plan-row' }, h('span', { class: 'plan-k' }, k), h('b', {}, v));
  openSheet(t('reached.title'), h('div', { class: 'form', 'data-rig': 'reached-sheet' },
    h('div', { class: 'party', 'aria-hidden': 'true' }, Array.from({ length: 10 }, (_, i) => h('span', { class: `bit b${i}` })),
      hexRing(1, 120, h('div', {}, goalIcon(goal), h('div', { class: 'pct big' }, '100%')), { width: 7 })),
    h('h2', { class: 'center' }, t('reached.headline', { name: goal.name })),
    h('div', { class: 'card flat' },
      row(t('reached.saved'), nim(prog.saved)),
      prog.gifts ? row(t('goal.gifts'), nim(prog.gifts)) : null,
      row(t('goal.earned'), `+${nim(prog.earned)}`),
      row(t('reached.took'), days < 1 ? t('reached.today') : tn('reached.days', Math.round(days)))),
    h('p', { class: 'small' }, t('reached.choose')),
    h('button', { class: 'btn primary wide', 'data-rig': 'rs-next', onclick: () => sheetGoal(null, '', { from: goal }) }, t('reached.next')),
    h('button', { class: 'btn wide', 'data-rig': 'rs-use', onclick: () => sheetUse(goal) }, t('reached.use')),
    h('button', { class: 'btn wide ghost', 'data-rig': 'rs-keep', onclick: () => closeSheet() }, t('reached.keep')),
    h('p', { class: 'tiny mute center' }, t('reached.keepNote'))));
}

/** Using what a goal saved: out of the stake, into the wallet, then pay with it. Honest about each step. */
function sheetUse(goal) {
  const prog = goalProgress(goal);
  const height = R.height ?? 0;
  const startRelease = height ? S.releaseIfStartedAt(height, R.network) : 0;
  const eta = startRelease ? t('use.s1eta', { time: hours(startRelease - height) }) : t('wd.s2any');
  const step = (n, title, body) => h('li', { class: 'step' }, h('span', { class: 'step-n' }, n), h('div', {}, h('b', {}, title), h('div', { class: 'tiny mute' }, body)));
  const staked = prog.stake > 0 || (R.staker?.inactive ?? 0) > 0;
  openSheet(t('use.title'), h('div', { class: 'form', 'data-rig': 'use-sheet' },
    h('p', { class: 'small' }, t('use.intro', { amount: nim(prog.stake + prog.earned) })),
    h('ol', { class: 'steps' },
      step(1, t('use.s1'), eta),
      step(2, t('use.s2'), t('use.s2b')),
      step(3, t('use.s3'), t('use.s3b'))),
    staked ? h('button', { class: 'btn primary wide', 'data-rig': 'use-start', onclick: () => sheetWithdraw(goal) }, t('use.start')) : null,
    h('button', { class: `btn wide ${staked ? '' : 'primary'}`, 'data-rig': 'use-pay', onclick: () => sheetPayInvoice(goal) }, icon('bolt', 18), t('spend.pay')),
    h('p', { class: 'tiny mute' }, t('use.honest'))));
}

/** Pay a Bitcoin Lightning invoice with Nimiq Pay. Kuza checks the text and hands it over; the wallet does the rest. */
function sheetPayInvoice(goal) {
  const input = h('textarea', { rows: 3, maxlength: 2100, placeholder: 'lnbc…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'data-rig': 'ln-input' });
  const msg = h('p', { class: 'tiny', 'data-rig': 'ln-msg' });
  const btn = h('button', { class: 'btn primary wide', 'data-rig': 'ln-pay', disabled: true }, icon('bolt', 18), t('spend.payGo'));
  let checked = null;
  let sending = false;
  const check = () => {
    checked = P.checkInvoice(input.value, R.network);
    msg.className = `tiny ${checked.ok ? 'good' : input.value.trim() ? 'bad' : 'mute'}`;
    msg.textContent = checked.ok
      ? (checked.sats ? t('spend.okSats', { sats: fmtSats(checked.sats) }) : t('spend.okLnurl'))
      : input.value.trim() ? t(`spend.err.${checked.reason}`) : t('spend.paste');
    btn.disabled = sending || !checked.ok;
  };
  input.addEventListener('input', check);
  btn.addEventListener('click', async () => {
    if (sending || !checked?.ok) return;
    const provider = W.getProvider();
    if (typeof provider?.payLightningInvoice !== 'function') { toast(t('err.update'), 'bad', 6000); return; }
    sending = true;
    btn.disabled = true;
    // Stored before the wallet is asked, so a closed sheet, a reload or a crash can't lead to a second payment.
    const tried = await sha256Hex(checked.invoice);
    if (st.lnTried.includes(tried)) {
      toast(t('spend.duplicate'), 'bad', 7000);
      btn.textContent = t('spend.payGo');
      sending = false; // the button stays off until the text changes; the same invoice is refused again here
      return;
    }
    st.lnTried = [...st.lnTried, tried].slice(-50);
    saveState();
    btn.textContent = t('save.waiting');
    let keepOff = false;
    try {
      const res = await provider.payLightningInvoice({ invoice: checked.invoice });
      const hash = typeof res?.hash === 'string' && /^[0-9a-fA-F]{64}$/.test(res.hash) ? res.hash : null;
      const entry = { kind: 'spend', luna: 0, at: Date.now(), status: 'ok', hash: hash || undefined, sats: checked.sats || undefined };
      goal?.entries.push(entry);
      saveState();
      closeSheet(true);
      render();
      toast(t('spend.sent'), 'good', 6000);
      forgetWallet();
      if (hash) {
        const tx = await C.waitForTx(hash, { tries: 20 }).catch(() => null);
        if (tx && Number.isSafeInteger(tx.value)) { entry.luna = tx.value; saveState(); }
      }
      await rereadWallet();
      if (!sheetOpen()) render();
      return;
    } catch (err) {
      const kind = W.classifyError(err);
      // Only a cancel or a refusal before sending proves nothing went out; anything else may have been paid.
      keepOff = !['cancel', 'invalid'].includes(kind);
      if (!keepOff) {
        st.lnTried = st.lnTried.filter((x) => x !== tried);
        saveState();
      }
      if (kind === 'cancel') toast(t('toast.cancel'));
      else if (kind === 'duplicate') toast(t('spend.duplicate'), 'bad', 7000);
      else if (kind === 'unknown' || kind === 'network') toast(t('spend.unknown'), 'bad', 8000);
      else if (kind === 'invalid' && /expired/i.test(err?.message || '')) toast(t('spend.expired'), 'bad', 6000);
      else if (kind === 'invalid') toast(t('spend.invalid'), 'bad', 6000);
      else walletFailure(err);
    }
    sending = keepOff; // after an unclear answer the same invoice is never sent twice
    btn.textContent = t('spend.payGo');
    btn.disabled = keepOff || !checked?.ok;
  });
  openSheet(t('spend.title'), h('div', { class: 'form', 'data-rig': 'ln-sheet' },
    h('p', { class: 'small' }, t('spend.body')),
    field(t('spend.label'), input),
    msg,
    btn,
    h('p', { class: 'tiny mute' }, t('spend.note'))));
  check();
}

function sheetWithdraw(goal) {
  const staker = R.staker;
  const height = R.height ?? 0;
  const stage = S.withdrawStage(staker, height, R.jail);
  const startRelease = height ? S.releaseIfStartedAt(height, R.network) : 0;

  const step = (n, title, body, state) => h('li', { class: `step ${state}` }, h('span', { class: 'step-n' }, state === 'done' ? icon('check', 14) : n), h('div', {}, h('b', {}, title), body ? h('div', { class: 'tiny mute' }, body) : null));

  if (st.op) {
    openSheet(t('wd.title'), h('div', { class: 'form' }, h('p', { class: 'small' }, t('wd.waitOp')), h('button', { class: 'btn wide', onclick: () => closeSheet() }, t('common.ok'))));
    return;
  }

  if (stage.stage === 'cooling' || stage.stage === 'retire' || stage.stage === 'remove') {
    const cooling = stage.stage === 'cooling';
    const eta = cooling ? Date.now() + S.blocksToMs(stage.blocksLeft) : 0;
    const steps = h('ol', { class: 'steps' },
      step(1, t('wd.s1'), null, 'done'),
      step(2, t('wd.s2'), cooling ? t('wd.s2left', { time: hours(stage.blocksLeft), date: when(eta) }) : t('wd.s2done'), cooling ? 'now' : 'done'),
      step(3, t('wd.s3'), t('wd.s3b'), cooling ? '' : 'now'));
    const kids = [
      h('p', { class: 'small' }, t('wd.cooling', { amount: nim(stage.amount) })),
      steps,
    ];
    if (R.jail > height) kids.push(h('p', { class: 'tiny warn' }, t('wd.jailed')));
    const plan = S.retirePlan(staker);
    const stuck = stage.stage === 'retire' && !plan.amount;
    if (stage.stage === 'retire' && plan.leaves && plan.amount) kids.push(h('p', { class: 'tiny warn' }, t('wd.partial', { amount: nim(plan.leaves) })));
    if (stuck) kids.push(h('p', { class: 'tiny warn' }, t('wd.stuck')));
    if (cooling || stuck) {
      kids.push(h('button', { class: 'btn wide', 'data-rig': 'wd-resume', onclick: stopCooling }, t('wd.resume')));
      kids.push(h('p', { class: 'tiny mute center' }, t('wd.resumeNote')));
    } else {
      kids.push(h('button', { class: 'btn primary wide', 'data-rig': 'wd-release', onclick: runRelease }, stage.stage === 'retire' ? t('wd.release2') : t('wd.release1')));
      if (stage.stage === 'retire') kids.push(h('p', { class: 'tiny mute center' }, t('wd.twoSheets')));
    }
    openSheet(t('wd.title'), h('div', { class: 'form' }, kids));
    return;
  }

  if (stage.stage === 'none' || !staker) {
    openSheet(t('wd.title'), h('div', { class: 'form' }, h('p', { class: 'small' }, t('wd.nothing')), h('button', { class: 'btn wide', onclick: () => closeSheet() }, t('common.ok'))));
    return;
  }

  const prog = goal ? goalProgress(goal) : null;
  const suggested = Math.min(staker.active, prog ? prog.stake + prog.earned : staker.active);
  const amount = h('input', { type: 'text', inputmode: 'decimal', value: plainNim(suggested), autocomplete: 'off', 'data-rig': 'w-amount' });
  const msg = h('div', {});
  const btn = h('button', { class: 'btn danger wide', 'data-rig': 'w-submit' }, t('wd.start'));
  const check = () => {
    const luna = toLuna(amount.value);
    const res = luna ? S.checkWithdraw(luna, staker) : { ok: false, reason: 'invalid' };
    const kids = [];
    if (res.reason === 'dust') {
      kids.push(h('p', { class: 'tiny warn' }, t('wd.dust')));
      kids.push(h('div', { class: 'quick' },
        h('button', { type: 'button', class: 'chip-btn', onclick: () => { amount.value = plainNim(res.all); check(); } }, t('wd.all', { amount: nim(res.all, 5) })),
        res.max > 0 ? h('button', { type: 'button', class: 'chip-btn', onclick: () => { amount.value = plainNim(res.max); check(); } }, t('wd.leave', { amount: nim(res.max, 5) })) : null));
    } else if (res.reason === 'too_much') {
      kids.push(h('p', { class: 'tiny bad' }, t('wd.tooMuch', { amount: nim(res.max) })));
    } else if (res.reason === 'invalid') {
      kids.push(h('p', { class: 'tiny bad' }, t('form.errAmount')));
    }
    msg.replaceChildren(...kids);
    btn.disabled = !res.ok;
    return res.ok ? luna : null;
  };
  amount.addEventListener('input', check);
  btn.addEventListener('click', () => {
    const luna = check();
    if (luna) {
      btn.disabled = true;
      startCooling(goal, luna).finally(() => { if (sheetOpen()) check(); });
    }
  });
  const eta = startRelease ? Date.now() + S.blocksToMs(startRelease - height) : 0;
  openSheet(goal && goalProgress(goal).ratio < 1 ? t('wd.breakTitle', { name: goal.name }) : t('wd.title'), h('div', { class: 'form' },
    goal && goalProgress(goal).ratio < 1 ? h('p', { class: 'small' }, t('wd.breakNote', { left: nim(goalProgress(goal).left) })) : null,
    h('p', { class: 'small' }, t('wd.free')),
    field(t('wd.amount'), amount),
    msg,
    h('ol', { class: 'steps' },
      step(1, t('wd.s1'), t('wd.s1b'), 'now'),
      step(2, t('wd.s2'), startRelease ? t('wd.s2est', { time: hours(startRelease - height), date: when(eta) }) : t('wd.s2any'), ''),
      step(3, t('wd.s3'), t('wd.s3b'), '')),
    btn,
    h('button', { class: 'btn wide', 'data-rig': 'w-keep', onclick: () => closeSheet() }, t('wd.keep'))));
  check();
}

function sheetSettings() {
  const select = h('select', { 'data-rig': 'lang', onchange: (e) => { st.lang = e.target.value || null; saveState(); setLang(st.lang || pickLang(W.hostLanguage())); closeSheet(true); render(); } },
    h('option', { value: '' }, t('settings.auto')),
    Object.entries(LANGS).map(([code, label]) => h('option', { value: code }, label)));
  select.value = st.lang || '';
  openSheet(t('settings.title'), h('div', { class: 'form' },
    field(t('settings.lang'), select),
    h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: !st.noCount, onchange: (e) => { st.noCount = !e.target.checked; saveState(); } }),
      h('span', { class: 'small' }, t('settings.count'))),
    st.address ? h('p', { class: 'tiny mute' }, t('settings.wallet', { address: shortAddress(st.address) })) : null,
    st.address ? h('button', { class: 'btn wide', 'data-rig': 'reconnect', onclick: async () => { closeSheet(true); try { W.getProvider()?.disconnect?.(); await connect(); await sync(); } catch (err) { walletFailure(err); } } }, t('settings.refresh')) : null,
    h('a', { class: 'btn wide', href: '#/how', onclick: () => closeSheet(true) }, t('foot.how'))));
}

/* ---------- group jar ---------- */

/** The goal a friend was invited to, read from the chain: how much has come in and from how many wallets. */
function jarTotals() {
  const gifts = R.gifts || [];
  return { total: gifts.reduce((sum, g) => sum + g.luna, 0), people: new Set(gifts.map((g) => g.from)).size };
}

function jarHero(jar, size = 140) {
  const { total, people } = jarTotals();
  const ratio = Math.min(1, total / jar.target);
  return h('section', { class: 'goal-hero', 'data-rig': 'jar-hero' },
    hexRing(ratio, size, h('div', {}, h('div', { class: 'gi' }, icon('gift', 26)), h('div', { class: 'pct' }, `${Math.floor(ratio * 100)}%`)), { width: 6 }),
    h('p', { class: 'small mute' }, t('jar.from', { address: shortAddress(jar.owner) })),
    h('h1', {}, jar.name),
    h('div', { class: 'mute' }, R.gifts === null ? '…' : t('jar.progress', { amount: fmtNim(total, lang(), 0), target: nim(jar.target, 0) })),
    R.gifts === null ? null : h('div', { class: 'tiny mute', 'data-rig': 'jar-people' }, people ? tn('jar.people', people) : t('jar.firstOne')),
    jar.date ? h('div', { class: 'tiny mute' }, t('goal.by', { date: dateText(jar.date) })) : null);
}

/** Gifts so far. The public invite page shows amounts only: a note is text a stranger paid 1 NIM to publish. */
function giftList(notes = true) {
  const gifts = R.gifts;
  return h('section', { class: 'card' }, h('h3', {}, t('jar.gifts')),
    gifts === null
      ? h('div', { class: 'skeleton w60' })
      : gifts.length
        ? gifts.slice(0, 8).map((g) => h('div', { class: 'entry' },
          h('div', {}, h('div', { class: 'small' }, (notes && g.note) || t('entry.gift')), h('div', { class: 'tiny mute' }, `${day(g.at)} · ${shortAddress(g.from)}`)),
          h('div', { class: 'entry-v' }, `+${nim(g.luna)}`)))
        : h('p', { class: 'small mute' }, t('jar.none')));
}

/** The address of this invite as it should be shared and opened: always the short public form. */
const jarLink = (jar) => I.inviteLink(jar, jar.owner, jar.net);

function viewJar() {
  const jar = R.jar;
  if (!W.inHost() && !DEMO) return viewInvite(jar);
  const wrongNet = jar.net !== R.network;
  const mine = st.address === jar.owner || R.accounts.includes(jar.owner);
  const memoFor = (note) => J.buildMemo(jar.id, note);
  const amount = h('input', { type: 'text', inputmode: 'decimal', placeholder: '100', autocomplete: 'off', 'data-rig': 'j-amount' });
  const note = h('input', { type: 'text', maxlength: 40, placeholder: t('jar.notePh'), autocomplete: 'off', 'data-rig': 'j-note' });
  const err = h('p', { class: 'tiny bad' });
  const fiatLine = h('p', { class: 'tiny mute', 'data-rig': 'j-fiat' });
  const btn = h('button', { class: 'btn primary wide', 'data-rig': 'j-send', disabled: Boolean(R.jarSending) }, R.jarSending ? t('save.waiting') : t('jar.send'));
  const label = () => {
    const luna = toLuna(amount.value);
    fiatLine.textContent = luna && fiat(luna) ? `≈ ${fiat(luna)}` : '';
    if (!R.jarSending) btn.textContent = luna ? t('jar.sendAmount', { amount: nim(luna, 5) }) : t('jar.send');
  };
  amount.addEventListener('input', label);
  const release = () => {
    R.jarSending = false;
    btn.disabled = false;
    label();
  };
  const finish = async (hash, luna) => {
    const before = jarTotals().total;
    const tx = await C.waitForTx(hash);
    await loadJarGifts();
    if (!tx) {
      btn.textContent = t('save.waiting');
      toast(t('toast.slow'), 'info', 6000);
    } else if (tx.executionResult === false) {
      toast(t('err.failedTx'), 'bad', 6000);
      release();
    } else {
      R.jarSending = false;
      renderJarDone(luna, hash, before);
    }
  };
  btn.addEventListener('click', async () => {
    if (R.jarSending) return;
    const luna = toLuna(amount.value);
    if (!luna) { err.textContent = t('form.errAmount'); return; }
    if (luna < LUNA) { err.textContent = t('jar.min'); return; }
    err.textContent = '';
    R.jarSending = true;
    btn.disabled = true;
    btn.textContent = t('save.waiting');
    const stop = (text) => { if (text) err.textContent = text; release(); };
    let provider;
    try {
      provider = W.getProvider();
      if (!(await walletReady()) || !(await ensureFresh())) return stop();
      if (st.address === jar.owner || R.accounts.includes(jar.owner)) return stop(t('jar.mine'));
      if (R.spendable === null) return stop(t('err.balance'));
      if (luna > R.spendable) return stop(t('save.tooMuch', { amount: nim(R.spendable) }));
      // A payment to anything but a plain account could be refused and leave the sender's wallet waiting.
      if ((await C.getAccountType(jar.owner)) !== 'basic') return stop(t('jar.notPayable'));
    } catch {
      return stop(t('err.network'));
    }
    try {
      const hash = await provider.sendBasicTransactionWithData({ recipient: jar.owner, value: luna, data: memoFor(note.value) });
      toast(t('jar.sent'), 'good');
      return finish(hash, luna);
    } catch (e) {
      const kind = W.classifyError(e);
      walletFailure(e);
      if (kind !== 'unknown' && kind !== 'network') return release();
      // It may have gone out. The button stays off so it can't be paid twice.
      const hash = W.errorHash(e);
      if (hash) return finish(hash, luna);
      btn.textContent = t('save.waiting');
    }
    return undefined;
  });

  const payBox = wrongNet
    ? h('section', { class: 'card notice' }, h('div', { class: 'notice-i' }, icon('info')), h('div', { class: 'small' }, t('jar.wrongNet')))
    : mine
      ? h('section', { class: 'card' }, h('p', { class: 'small' }, t('jar.mine')), h('a', { class: 'btn wide', href: `${location.pathname}${DEMO ? '?demo=1' : ''}#/goal/${jar.id}` }, t('jar.open')))
      : h('section', { class: 'card form', 'data-rig': 'j-form' },
        h('h3', {}, t('jar.addTitle')),
        h('p', { class: 'small' }, t('jar.why')),
        // Whoever made the link chose this address. A copied link can be edited, so the address is shown in full and
        // the warning sits above the amount, not behind a tap.
        h('p', { class: 'tiny mute', 'data-rig': 'j-trust' }, t('jar.trust')),
        h('code', { class: 'mono', 'data-rig': 'j-owner' }, jar.owner),
        field(t('jar.amount'), amount),
        fiatLine,
        h('div', { class: 'quick' }, [100, 1000, 5000].map((n) => h('button', { type: 'button', class: 'chip-btn', onclick: () => { amount.value = String(n); label(); } }, fmtNim(n * LUNA, lang())))),
        field(t('jar.note'), note),
        h('p', { class: 'tiny mute' }, t('jar.public')),
        err, btn,
        h('p', { class: 'tiny mute center' }, t('jar.direct')),
        h('p', { class: 'tiny mute center' }, t('jar.countNote')));

  return chrome(h('main', { 'data-rig': 'jar' },
    jarHero(jar),
    payBox,
    giftList(),
    h('a', { class: 'btn wide', href: location.pathname + (DEMO ? '?demo=1' : ''), 'data-rig': 'j-own' }, t('jar.own')),
    h('p', { class: 'tiny mute center' }, t('jar.how'))));
}

/**
 * The invite in an ordinary phone or computer browser: the goal first, one button into Nimiq Pay (installed or not),
 * what Nimiq Pay is and how to get it, and, for anyone with another Nimiq wallet, the address and the exact message.
 */
function viewInvite(jar) {
  const link = jarLink(jar);
  const memo = J.buildMemo(jar.id, '');
  const stores = I.storeFor(PLATFORM);
  const help = h('p', { class: 'small warn', 'data-rig': 'inv-noapp', hidden: true }, t('inv.noApp'));
  const open = (e) => {
    if (!PLATFORM) {
      e.preventDefault();
      sheetQR(link, t('inv.qrTitle'), t('inv.qrBody'));
      return;
    }
    {
      // If the page is still in front a moment later, nothing took the link: no app (iOS has no store fallback), or a
      // chat app's built-in browser that won't hand links to other apps (Android). Say what to do about either.
      const at = Date.now();
      const timer = setInterval(() => {
        if (document.hidden) { clearInterval(timer); return; }
        if (Date.now() - at > 2500) { clearInterval(timer); help.hidden = false; help.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      }, 250);
    }
  };
  const copyBtn = (text, rig) => h('button', { type: 'button', class: 'btn small', 'data-rig': rig, onclick: async () => { const ok = await copyText(text); toast(ok ? t('share.copied') : t('share.select'), ok ? 'good' : 'info'); } }, icon('link', 16), t('inv.copy'));
  const step = (n, title, body, extra) => h('li', { class: 'step' }, h('span', { class: 'step-n' }, n), h('div', { class: 'grow' }, h('b', {}, title), h('div', { class: 'tiny mute' }, body), extra || null));
  const storeBtn = (url) => h('a', { class: 'btn small store', href: url, target: '_blank', rel: 'noopener noreferrer', 'data-rig': url.includes('apple') ? 'store-ios' : 'store-android' },
    url.includes('apple') ? t('inv.appStore') : t('inv.playStore'));
  return chrome(h('main', { 'data-rig': 'invite' },
    jarHero(jar, 128),
    h('section', { class: 'card form inv-cta' },
      h('p', { class: 'small' }, t('inv.ask', { name: jar.name })),
      h('a', { class: 'btn primary wide', href: I.openInPayLink(link, PLATFORM), onclick: open, 'data-rig': 'open-pay' }, t('inv.open')),
      help,
      h('p', { class: 'tiny mute center' }, PLATFORM ? t('inv.openNote') : t('inv.desktopNote'))),
    h('section', { class: 'card', 'data-rig': 'inv-new' },
      h('h3', {}, t('inv.newTitle')),
      h('p', { class: 'small' }, t('inv.what')),
      h('ol', { class: 'steps' },
        step(1, t('inv.s1'), t('inv.s1b'), h('div', { class: 'stores' }, stores.map(storeBtn))),
        step(2, t('inv.s2'), t('inv.s2b')),
        step(3, t('inv.s3'), t('inv.s3b', { name: jar.name })))),
    giftList(false),
    h('details', { class: 'card trust', 'data-rig': 'inv-other' },
      h('summary', { class: 'small' }, t('inv.otherTitle')),
      h('p', { class: 'tiny mute' }, t('inv.otherBody')),
      h('div', { class: 'copy-row' }, h('code', { class: 'mono grow', 'data-rig': 'inv-owner' }, jar.owner), copyBtn(jar.owner.replace(/\s/g, ''), 'inv-copy-addr')),
      h('p', { class: 'tiny mute' }, t('jar.withMsg')),
      h('div', { class: 'copy-row' }, h('code', { class: 'mono grow', 'data-rig': 'inv-memo' }, memo), copyBtn(memo, 'inv-copy-memo')),
      h('p', { class: 'tiny mute' }, t('jar.trust'))),
    h('p', { class: 'tiny mute center' }, t('inv.foot')),
    h('p', { class: 'center small' }, h('a', { href: APP_URL, 'data-rig': 'inv-about' }, t('inv.about')))));
}

/** After a friend's gift is mined: the goal moves, the proof, and a reason to start their own. */
function renderJarDone(luna, hash, before = 0) {
  const jar = R.jar;
  const { total, people } = jarTotals();
  const after = Math.max(total, before + luna);
  const from = Math.min(1, before / jar.target);
  const to = Math.min(1, after / jar.target);
  const ring = hexRing(to, 132, h('div', {}, h('div', { class: 'gi' }, icon('gift', 24)), h('div', { class: 'pct' }, `${Math.floor(to * 100)}%`)), { width: 7 });
  const arc = ring.querySelectorAll('path')[1];
  if (arc && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    arc.setAttribute('stroke-dasharray', `${(from * 100).toFixed(2)} 100`);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      arc.style.transition = 'stroke-dasharray .9s cubic-bezier(.2, 0, 0, 1)';
      arc.setAttribute('stroke-dasharray', `${(to * 100).toFixed(2)} 100`);
    }));
  }
  const base = location.pathname + (DEMO ? '?demo=1' : '');
  const ideas = [t('idea.emergency'), t('idea.phone'), t('idea.school'), t('idea.trip')];
  root().replaceChildren(chrome(h('main', { 'data-rig': 'thanks' },
    h('section', { class: 'goal-hero thanks' },
      h('div', { class: 'party', 'aria-hidden': 'true' }, Array.from({ length: 10 }, (_, i) => h('span', { class: `bit b${i}` })), ring),
      h('div', { class: 'plus', 'data-rig': 'thanks-plus' }, `+${nim(luna)}`),
      h('h1', {}, t('jar.thanks')),
      h('p', { class: 'mute' }, t('jar.thanksBody', { amount: nim(luna), name: jar.name })),
      h('p', { class: 'small', 'data-rig': 'thanks-total' }, t('jar.progress', { amount: fmtNim(after, lang(), 0), target: nim(jar.target, 0) }), people ? ` · ${tn('jar.people', people)}` : ''),
      /^[0-9a-fA-F]{64}$/.test(hash || '') ? h('a', { class: 'tiny', href: C.explorerTx(hash), target: '_blank', rel: 'noopener noreferrer', 'data-rig': 'thanks-proof' }, t('entry.proof')) : null),
    h('section', { class: 'card own-goal', 'data-rig': 'thanks-own' },
      h('h3', {}, t('thanks.ownTitle')),
      h('p', { class: 'small' }, t('thanks.ownBody')),
      h('div', { class: 'ideas' }, ideas.map((name) => h('a', { class: 'chip-btn', href: `${base}#/new/${encodeURIComponent(name)}` }, name))),
      h('a', { class: 'btn primary wide', href: `${base}#/new/`, 'data-rig': 'j-own' }, t('jar.own'))),
    h('button', { class: 'btn wide', 'data-rig': 'thanks-pass', onclick: async () => { const ok = await copyText(t('share.msgFriend', { name: jar.name, link: jarLink(jar) })); toast(ok ? t('share.copiedMsg') : t('share.select'), ok ? 'good' : 'info'); } }, icon('share', 18), t('thanks.pass')))));
}

async function loadJarGifts() {
  try {
    const history = await C.getHistory(R.jar.owner, 300);
    R.gifts = J.giftsFromHistory(history, R.jar.owner, R.jar.id);
  } catch {
    R.gifts = R.gifts ?? [];
    R.online = false;
  }
}

/* ---------- outside the app ---------- */

/** A normal browser shows the static landing page from index.html; the app root stays empty. False if it isn't there. */
function showLanding() {
  const page = document.getElementById('landing');
  if (!page) return false;
  document.documentElement.classList.remove('app');
  if (!R.landing) {
    R.landing = true;
    root().replaceChildren();
    import('./site.js').then((m) => m.start(page)).catch(() => {});
  }
  return true;
}

/** Anywhere the app runs, the landing page goes (index.html already hid it before the first paint). */
function dropLanding() {
  document.documentElement.classList.add('app');
  document.getElementById('landing')?.remove();
}

function viewOutside() {
  return h('div', { class: 'page' },
    h('main', { class: 'welcome' },
      h('div', { class: 'welcome-mark' }, logo(84)),
      h('h1', {}, t('welcome.title')),
      h('p', { class: 'lead' }, t('outside.sub')),
      h('a', { class: 'btn primary wide', href: I.openInPayLink(APP_URL, PLATFORM), 'data-rig': 'open-pay' }, t('outside.open')),
      h('p', { class: 'small center' }, t('outside.manual')),
      h('code', { class: 'mono center' }, APP_URL),
      h('a', { class: 'btn wide', href: `${location.pathname}?demo=1`, 'data-rig': 'demo' }, t('outside.demo')),
      h('p', { class: 'tiny mute center' }, t('outside.demoNote')),
      h('p', { class: 'center small' }, h('a', { href: REPO, target: '_blank', rel: 'noopener noreferrer' }, t('how.code')))));
}

/* ---------- router and boot ---------- */

const VIEW_IN_MS = 200; // matches .view-in in app.css

function render() {
  const el = root();
  const scroll = window.scrollY;
  let hash = location.hash;
  let view;
  let kind; // which screen this is, for the entrance below
  if (hash.startsWith('#/new') && !R.jar) {
    // From a friend's thank-you screen: open the new goal form, with the idea they tapped filled in.
    let idea = '';
    try { idea = J.cleanText(decodeURIComponent(hash.slice(6)), 40); } catch { idea = ''; }
    R.openNew = idea;
    history.replaceState(null, '', `${location.pathname}${location.search}#/`);
    hash = '#/';
  }
  if (!hash.startsWith('#/goal/') || R.banner?.id !== hash.slice(7)) R.banner = null;
  checkMarks();
  if (R.jar) { view = viewJar(); kind = 'jar'; }
  else if (!W.inHost() && !DEMO) {
    if (showLanding()) return;
    view = viewOutside(); kind = 'outside';
  }
  else if (hash === '#/how') { view = viewHow(); kind = 'how'; }
  else if (!st.address) { view = viewWelcome(); kind = 'welcome'; }
  else if (hash.startsWith('#/goal/')) { view = viewGoal(findGoal(hash.slice(7))); kind = hash; }
  else { view = viewHome(); kind = 'home'; }
  dropLanding();
  // Re-renders of the same screen (a sync every 30 s) stay still; a new screen settles in.
  // The first screen after boot gets no entrance, so the welcome text paints at once.
  // A sync can re-render right after the change; the new copy picks the entrance up where it was, so it never restarts.
  if (view instanceof Element) {
    const now = performance.now();
    if (el.dataset.view && el.dataset.view !== kind) R.viewAt = now;
    else if (el.dataset.view !== kind) R.viewAt = null;
    const into = R.viewAt == null ? Infinity : now - R.viewAt;
    if (into < VIEW_IN_MS) {
      view.classList.add('view-in');
      view.style.animationDelay = `${-Math.round(into)}ms`;
    }
  }
  el.dataset.view = kind;
  el.replaceChildren(view);
  document.documentElement.lang = lang();
  if (el.dataset.hash === hash) window.scrollTo(0, scroll);
  else window.scrollTo(0, 0);
  el.dataset.hash = hash;
  afterRender(kind);
}

/**
 * Progress moments. A goal passing 25, 50 or 75% gets a banner on its page; reaching 100% gets the celebration sheet,
 * once. Goals from before marks existed start from where they stand, so nothing old is celebrated as new.
 */
function checkMarks() {
  if (R.jar || !st.address || R.staker === undefined || R.proven === undefined) return; // wait for stake and proof, or rewards would look like new progress
  let changed = false;
  for (const goal of openGoals()) {
    const ratio = goalProgress(goal).ratio;
    if (!Array.isArray(goal.marks)) {
      goal.marks = G.passedMarks(ratio);
      if (ratio >= 1 && !goal.reachedAt) goal.reachedAt = Date.now();
      changed = true;
      continue;
    }
    if (hasPending()) continue; // celebrate confirmed money only
    const mark = G.newMark(goal, ratio);
    if (!mark) continue;
    goal.marks = G.MARKS.filter((m) => m <= mark || goal.marks.includes(m));
    changed = true;
    if (mark === 100) {
      if (!goal.reachedAt) goal.reachedAt = Date.now();
      R.celebrate = goal.id;
    } else {
      R.banner = { id: goal.id, mark };
      toast(t(`mark.${mark}`), 'good', 4500);
    }
  }
  if (changed) saveState();
}

function afterRender(kind) {
  if (sheetOpen()) return;
  if (R.celebrate) {
    const goal = findGoal(R.celebrate);
    R.celebrate = null;
    if (goal && !goal.closedAt) {
      if (kind !== `#/goal/${goal.id}`) location.hash = `#/goal/${goal.id}`;
      sheetReached(goal);
      return;
    }
  }
  if (R.openNew !== undefined && st.address && kind === 'home') {
    const idea = R.openNew;
    R.openNew = undefined;
    sheetGoal(null, idea);
  }
}

function fatal() {
  dropLanding();
  root().replaceChildren(h('div', { class: 'page' }, h('main', { class: 'welcome' },
    h('div', { class: 'welcome-mark' }, logo(84)),
    h('h1', {}, t('fatal.title')),
    h('p', { class: 'lead' }, t('fatal.body')),
    h('button', { class: 'btn primary wide', onclick: () => location.reload() }, t('fatal.retry')))));
}

async function boot() {
  document.addEventListener('touchstart', () => {}, { passive: true }); // lets iOS WebViews show :active pressed states
  if (DEMO) {
    const mock = await import('./mock.js');
    mock.install();
  }
  R.network = W.hostNetwork();
  R.fiat = W.hostFiat();
  C.useNetwork(R.network);

  const invite = J.readInvite(params);
  if (invite.given) {
    R.jar = invite.jar;
    if (R.jar && !W.inHost() && !DEMO) {
      R.network = R.jar.net;
      C.useNetwork(R.network);
    }
    if (!R.jar) toast(t('jar.bad'), 'bad', 6000);
  }

  st = loadState();
  setLang(st.lang || pickLang(W.hostLanguage() || navigator.language));
  render();
  if (R.landing) return undefined; // the landing page needs no wallet, chain or helper reads

  window.addEventListener('hashchange', render);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });

  loadExtras().catch(() => {});

  if (W.inHost() || DEMO) {
    try {
      await W.connectProvider(5000);
    } catch {
      return fatal();
    }
    W.onAccountsChanged(accountsChanged);
  }
  if (R.jar) {
    await loadJarGifts();
    if (!R.jarSending) render();
    return undefined;
  }
  setInterval(() => { if (!document.hidden && !sheetOpen()) sync(); }, 30e3);
  await sync();
  return undefined;
}

window.addEventListener('error', () => { if (!root()?.children.length || root().querySelector('.boot')) fatal(); });
window.addEventListener('unhandledrejection', (e) => { console.warn('unhandled', e.reason?.message); });

boot().catch(() => fatal());
