// Kuza: savings goals on top of the user's own NIM stake.
// Kuza holds nothing and sends nothing by itself. Money only moves through Nimiq Pay's own approval sheets.

import { LUNA, toLuna, fmtNim, fmtFiat, shortAddress, normalizeAddress, newId } from './nim.js';
import * as S from './staking.js';
import * as G from './goals.js';
import * as J from './jar.js';
import * as C from './chain.js';
import * as W from './wallet.js';
import * as A from './api.js';
import { h, icon, hexRing, logo, openSheet, closeSheet, sheetOpen, toast, copyText, GOAL_ICONS } from './ui.js';
import { t, tn, setLang, pickLang, LANGS, lang } from './i18n.js';

const params = new URLSearchParams(location.search);
const DEMO = params.get('demo') === '1';
const REPO = 'https://github.com/swiftbotlab/kuza';
const APP_URL = 'https://swiftbotlab.github.io/kuza/';
const HOUR = 3600e3;
const TX_WINDOW = 2.5 * HOUR; // a transaction not mined after its validity window never will be

const R = {
  network: 'mainnet', fiat: null, accounts: [], fresh: false, height: null, staker: undefined, wallet: null, spendable: null,
  validators: [], market: null, stats: null, online: true, syncedAt: 0, syncing: false, jar: null, jail: 0, gifts: null,
};
let st = G.sanitizeState(null);
const root = () => document.getElementById('app');

/* ---------- storage ---------- */

const storeKey = () => `kuza.v1.${R.network}`;

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

function when(ms) {
  return new Intl.DateTimeFormat(lang(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
}

function day(ms) {
  return new Intl.DateTimeFormat(lang(), { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ms));
}

function dateText(date) {
  return date ? day(Date.parse(date + 'T12:00:00Z')) : '';
}

function hours(blocks) {
  const hrs = S.blocksToMs(blocks) / HOUR;
  if (hrs < 1) return t('time.minutes', { n: Math.max(1, Math.round(hrs * 60)) });
  return t('time.hours', { n: Math.round(hrs) });
}

function rateText(fee = 0.05) {
  const gross = R.market?.rate;
  if (!gross) return null;
  return new Intl.NumberFormat(lang(), { style: 'percent', maximumFractionDigits: 1 }).format(gross * (1 - fee));
}

const earned = () => G.earnedTotal(R.staker?.total ?? 0, st.baseline ?? 0, st.goals);
const openGoals = () => st.goals.filter((g) => !g.closedAt);
const findGoal = (id) => st.goals.find((g) => g.id === id);
const poolOf = (address) => R.validators.find((v) => v.address === address) || null;

function goalProgress(goal) {
  return G.progress(goal, G.earnedShare(goal, st.goals, earned()));
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
  if (st.op?.hash) {
    const tx = await C.getTx(st.op.hash).catch(() => null);
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
  const v = await C.getValidator(staker.delegation).catch(() => null);
  if (v?.jailedFrom) R.jail = v.jailedFrom + S.BLOCKS_PER_EPOCH * S.JAIL_EPOCHS + 1;
}

let lastGiftCheck = 0;

async function sync() {
  if (R.syncing || !st.address) return;
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
    await Promise.all([checkPending(), refreshJail(staker)]);
    finishWithdrawIfDone();
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
    if (!sheetOpen()) render();
  }
}

async function loadExtras() {
  R.validators = await A.localValidators(R.network);
  const [fresh, market, stats] = await Promise.all([
    A.freshValidators(R.network), A.loadMarket(), A.loadStats(),
  ]);
  if (fresh) R.validators = fresh;
  R.market = market;
  R.stats = stats;
  if (!sheetOpen()) render();
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
  await readWallet();
  if (R.network === 'mainnet' && !DEMO && !st.seen && !st.noCount) {
    A.reportSeen(clean[0]).then(() => { st.seen = true; saveState(); }).catch(() => {});
  }
  return clean;
}

async function readWallet() {
  const { total, spendable } = await W.walletBalances(R.accounts);
  R.wallet = total;
  R.spendable = spendable;
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
  await sync();
  if (!tx) return toast(t('toast.slow'), 'info', 6000);
  if (tx.executionResult === false) return toast(t('err.failedTx'), 'bad', 6000);
  if (goal) toast(t('toast.saved'), 'good');
  return tx;
}

/**
 * The wallet's co-signer can refuse a transaction the network wouldn't accept, and the wallet then waits on it
 * and blocks further sends. So every transaction is checked against the chain as it is now, right before asking.
 */
async function preflightStake(value, pool) {
  const staker = await C.getStaker(st.address);
  R.staker = staker;
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
    const check = await preflightStake(value, pool);
    if (!check.ok) {
      toast(t('err.invalid'), 'bad', 6000);
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

async function startCooling(goal, amount) {
  const provider = W.getProvider();
  try {
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
    await settle(hash);
    toast(t('toast.cooling'), 'good');
  } catch (err) {
    noteUnknown(err, 'cool');
    walletFailure(err);
  }
}

async function stopCooling() {
  const provider = W.getProvider();
  try {
    const staker = await C.getStaker(st.address);
    R.staker = staker;
    const hash = await provider.sendSetActiveStakeTransaction({ newActiveBalance: staker.active + staker.inactive });
    st.unstake = null;
    st.op = { kind: 'uncool', hash, at: Date.now() };
    saveState();
    closeSheet(true);
    render();
    await settle(hash);
    toast(t('toast.resumed'), 'good');
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
  st.unstake = { ...(st.unstake || { goal: null }), removing: amount };
  saveState();
  render();
  const tx = await C.waitForTx(hash);
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
  const inWallet = openGoals().reduce((sum, g) => sum + G.parts(g).wallet, 0);
  const pool = poolOf(R.staker?.delegation);
  const rate = rateText(pool?.fee ?? 0.05);
  return h('section', { class: 'hero' },
    h('div', { class: 'hero-label' }, t('home.staked')),
    R.staker === undefined ? h('div', { class: 'skeleton w60' }) : amountBlock(staked, { big: true }),
    h('div', { class: 'hero-row' },
      h('div', {}, h('div', { class: 'hero-k' }, t('home.earned')), h('div', { class: 'hero-v' }, `+${nim(earned())}`)),
      h('div', {}, h('div', { class: 'hero-k' }, t('home.inWallet')), h('div', { class: 'hero-v' }, nim(inWallet))),
      rate ? h('div', {}, h('div', { class: 'hero-k' }, t('home.rate')), h('div', { class: 'hero-v' }, `~${rate}`)) : null),
    pool ? h('div', { class: 'hero-foot' }, t('home.pool', { name: pool.name })) : null);
}

function goalCard(goal) {
  const prog = goalProgress(goal);
  const run = G.streak(goal, Date.now());
  const track = G.onTrack(goal, prog.saved, Date.now());
  const pending = goal.entries.some((e) => e.status === 'pending');
  return h('button', { class: 'card goal', 'data-rig': `goal-${goal.id}`, onclick: () => { location.hash = `#/goal/${goal.id}`; } },
    hexRing(prog.ratio, 74, h('div', { class: 'pct' }, `${Math.floor(prog.ratio * 100)}%`)),
    h('div', { class: 'goal-main' },
      h('div', { class: 'goal-name' }, icon(goal.icon, 18), h('span', {}, goal.name)),
      h('div', { class: 'small' }, t('goal.of', { saved: fmtNim(prog.saved, lang()), target: nim(goal.target) })),
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
  const rate = rateText();
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
      point('clock', t('welcome.p3'), t('welcome.p3b'))),
    h('button', { class: 'btn primary wide', 'data-rig': 'connect', onclick: go }, t('welcome.connect')),
    h('p', { class: 'tiny mute center' }, t('welcome.note')),
    footer()));
}

function viewHome() {
  const goals = openGoals();
  const body = h('main', {},
    summaryCard(),
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
    footer());
  return chrome(body);
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
  const run = G.streak(goal, now);
  const reached = prog.ratio >= 1;
  const track = G.onTrack(goal, prog.saved, now);
  const weeks = G.weekStrip(goal, now, 8);
  const entries = [...goal.entries].sort((a, b) => b.at - a.at);
  const stakeable = prog.wallet > 0 && S.saveRoute(prog.wallet, R.staker).route !== 'aside';
  const body = h('main', {},
    h('section', { class: 'goal-hero' },
      hexRing(prog.ratio, 164, h('div', {}, goalIcon(goal), h('div', { class: 'pct big' }, `${Math.floor(prog.ratio * 100)}%`)), { width: 6 }),
      h('h1', {}, goal.name),
      h('div', { class: 'mute' }, t('goal.of', { saved: fmtNim(prog.saved, lang()), target: nim(goal.target) })),
      fiat(goal.target) ? h('div', { class: 'tiny mute' }, `≈ ${fiat(prog.saved)} / ${fiat(goal.target)}`) : null,
      goal.date ? h('div', { class: 'tiny mute' }, t('goal.by', { date: dateText(goal.date) })) : null),
    reached ? h('div', { class: 'card notice good' }, h('div', { class: 'notice-i' }, icon('check')), h('div', {}, h('b', {}, t('goal.doneTitle')), h('div', { class: 'small mute' }, t('goal.doneBody')))) : null,
    coolingCard(),
    h('div', { class: 'split' },
      h('div', { class: 'tile' }, h('div', { class: 'tile-k' }, t('goal.inStake')), h('div', { class: 'tile-v' }, nim(prog.stake))),
      h('div', { class: 'tile' }, h('div', { class: 'tile-k' }, t('goal.earned')), h('div', { class: 'tile-v good' }, `+${nim(prog.earned)}`)),
      h('div', { class: 'tile' }, h('div', { class: 'tile-k' }, t('goal.inWallet')), h('div', { class: 'tile-v' }, nim(prog.wallet))),
      h('div', { class: 'tile' }, h('div', { class: 'tile-k' }, t('goal.gifts')), h('div', { class: 'tile-v' }, nim(prog.gifts)))),
    stakeable ? h('button', { class: 'card notice gold', 'data-rig': 'stake-wallet', onclick: () => sheetSave(goal, { includeWallet: true }) },
      h('div', { class: 'notice-i' }, icon('seed')),
      h('div', {}, h('b', {}, t('goal.moveTitle', { amount: nim(prog.wallet) })), h('div', { class: 'small mute' }, t('goal.moveBody')))) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', 'data-rig': 'save', onclick: () => sheetSave(goal) }, icon('plus', 18), t('goal.save')),
      h('button', { class: 'btn', 'data-rig': 'share', onclick: () => sheetShare(goal) }, icon('share', 18), t('goal.share'))),
    goal.weekly ? h('section', { class: 'card' },
      h('div', { class: 'row-between' },
        h('b', {}, t('goal.plan', { amount: nim(goal.weekly, 0) })),
        run ? h('span', { class: 'chip fire' }, icon('flame', 13), tn('goal.streak', run)) : null),
      h('div', { class: 'weeks' }, weeks.map((w) => h('span', { class: `wk ${w.met ? 'met' : ''} ${w.current ? 'now' : ''}`, title: nim(w.amount) }))),
      track && !reached ? h('div', { class: 'small mute' }, track.ok ? t('goal.ahead') : t('goal.behindLong', { amount: nim(-track.delta, 0) })) : null) : null,
    h('section', { class: 'card' },
      h('h3', {}, t('goal.activity')),
      entries.length ? entries.slice(0, 30).map(entryRow) : h('p', { class: 'small mute' }, t('goal.noActivity'))),
    h('div', { class: 'links' },
      h('button', { class: 'link', 'data-rig': 'edit', onclick: () => sheetGoal(goal) }, t('goal.edit')),
      prog.stake > 0 || (R.staker?.inactive ?? 0) > 0
        ? h('button', { class: 'link danger', 'data-rig': 'break', onclick: () => sheetWithdraw(goal) }, reached ? t('goal.takeOut') : t('goal.break'))
        : h('button', { class: 'link danger', 'data-rig': 'delete', onclick: () => sheetDelete(goal) }, t('goal.delete'))));
  return chrome(body, { back: true, title: goal.name, tools: h('span', { class: 'icon-spacer' }) });
}

function entryRow(e) {
  const label = {
    aside: t('entry.aside'), gift: e.note ? t('entry.giftNote', { note: e.note }) : t('entry.gift'), stake: t('entry.stake'),
    assign: t('entry.assign'), withdraw: t('entry.withdraw'),
  }[e.kind] || e.kind;
  const sign = e.kind === 'withdraw' ? '−' : '+';
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
  const rate = rateText();
  const blk = (title, ...paras) => h('section', { class: 'card' }, h('h3', {}, title), paras.filter(Boolean).map((p) => h('p', { class: 'small' }, p)));
  return chrome(h('main', {},
    blk(t('how.q1'), t('how.a1')),
    blk(t('how.q2'), t('how.a2'), start ? t('how.a2live', { time: hours(start - R.height), date: when(Date.now() + S.blocksToMs(start - R.height)) }) : null),
    blk(t('how.q3'), t('how.a3'), rate ? t('how.a3rate', { rate }) : null),
    blk(t('how.q4'), t('how.a4')),
    blk(t('how.q5'), t('how.a5')),
    blk(t('how.q6'), t('how.a6')),
    blk(t('how.q7'), t('how.a7')),
    h('p', { class: 'center small' }, h('a', { href: REPO, target: '_blank', rel: 'noopener noreferrer' }, t('how.code')))), { back: true, title: t('how.title'), tools: h('span', { class: 'icon-spacer' }) });
}

/* ---------- sheets ---------- */

function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-k' }, label), input, hint || null);
}

function sheetGoal(goal = null, presetName = '') {
  const now = Date.now();
  let icn = goal?.icon || 'seed';
  const name = h('input', { type: 'text', maxlength: 40, value: goal?.name || presetName, placeholder: t('form.namePh'), autocomplete: 'off', 'data-rig': 'f-name' });
  const target = h('input', { type: 'text', inputmode: 'decimal', value: goal ? String(goal.target / LUNA) : '', placeholder: '50000', autocomplete: 'off', 'data-rig': 'f-target' });
  const date = h('input', { type: 'date', value: goal?.date || '', min: new Date(now + 864e5).toISOString().slice(0, 10), 'data-rig': 'f-date' });
  const weekly = h('input', { type: 'text', inputmode: 'decimal', value: goal?.weekly ? String(goal.weekly / LUNA) : '', placeholder: '0', autocomplete: 'off', 'data-rig': 'f-weekly' });
  const hint = h('p', { class: 'tiny mute' });
  const err = h('p', { class: 'tiny bad' });
  let touched = Boolean(goal?.weekly);
  weekly.addEventListener('input', () => { touched = true; });
  const update = () => {
    const luna = toLuna(target.value);
    const f = luna ? fiat(luna) : '';
    const sug = luna && date.value ? G.suggestWeekly(luna, date.value, now) : 0;
    if (sug && !touched) weekly.value = String(Math.ceil(sug / LUNA));
    hint.textContent = [f ? `≈ ${f}` : '', sug ? t('form.suggest', { amount: nim(sug, 0), weeks: G.weeksUntil(date.value, now) }) : ''].filter(Boolean).join(' · ');
  };
  target.addEventListener('input', update);
  date.addEventListener('change', update);
  const picks = h('div', { class: 'icons' }, GOAL_ICONS.map((name2) => h('button', { type: 'button', class: `pick ${name2 === icn ? 'on' : ''}`, 'aria-label': name2, onclick: (e) => { icn = name2; picks.querySelectorAll('.pick').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); } }, icon(name2))));
  const submit = () => {
    const cleanName = J.cleanText(name.value, 40);
    const luna = toLuna(target.value);
    const weeklyLuna = weekly.value.trim() ? toLuna(weekly.value) : 0;
    if (!cleanName) { err.textContent = t('form.errName'); return; }
    if (!luna || luna < LUNA) { err.textContent = t('form.errTarget'); return; }
    if (weeklyLuna === null) { err.textContent = t('form.errWeekly'); return; }
    if (date.value && Number.isNaN(Date.parse(date.value))) { err.textContent = t('form.errDate'); return; }
    if (goal) {
      Object.assign(goal, { name: cleanName, target: luna, date: date.value || null, weekly: weeklyLuna, icon: icn });
    } else {
      const fresh = G.newGoal({ id: newId(), name: cleanName, target: luna, date: date.value || null, weekly: weeklyLuna, icon: icn, now });
      st.goals.push(fresh);
      saveState();
      closeSheet(true);
      location.hash = `#/goal/${fresh.id}`;
      sheetSave(fresh, { first: true });
      return;
    }
    saveState();
    closeSheet(true);
    render();
  };
  const form = h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); submit(); } },
    field(t('form.name'), name),
    h('div', { class: 'icons-wrap' }, picks),
    field(t('form.target'), target),
    field(t('form.date'), date),
    field(t('form.weekly'), weekly),
    hint, err,
    h('button', { class: 'btn primary wide', type: 'submit', 'data-rig': 'f-submit' }, goal ? t('form.saveEdit') : t('form.create')));
  openSheet(goal ? t('form.editTitle') : t('form.newTitle'), form);
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

async function sheetSave(goal, { includeWallet = false, first = false } = {}) {
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
  const amount = h('input', { type: 'text', inputmode: 'decimal', value: preset ? String(Math.ceil(preset / LUNA)) : '', placeholder: '0', autocomplete: 'off', 'data-rig': 's-amount' });
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
    const noted = openGoals().reduce((sum, g) => sum + G.parts(g).wallet, 0);
    const tooMuch = R.spendable !== null && staked && value > R.spendable;
    plan = { value, part, route: route.route };
    fiatLine.textContent = value && fiat(value) ? `≈ ${fiat(value)}` : '';
    const kids = [];
    if (route.route === 'new') {
      kids.push(h('p', { class: 'small' }, t('save.routeNew')));
      kids.push(poolRow(pool, () => sheetPools((p) => { pool = p; sheetSave(goal, { includeWallet: useWallet }); })));
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
    if (route.route === 'aside' && R.wallet !== null && newMoney + noted > R.wallet) kids.push(h('p', { class: 'tiny warn' }, t('save.asideOver', { amount: nim(R.wallet) })));
    info.replaceChildren(...kids);
    btn.disabled = !value || route.route === 'invalid' || tooMuch || (route.route === 'new' && !pool);
    btn.textContent = route.route === 'aside' ? t('save.goAside', { amount: nim(newMoney) }) : staked ? t('save.goStake', { amount: nim(value) }) : t('save.go');
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

const fmtPct = (x) => new Intl.NumberFormat(lang(), { style: 'percent', maximumFractionDigits: 2 }).format(x);

function sheetPools(onPick) {
  openSheet(t('pool.title'), h('div', { class: 'form' },
    h('p', { class: 'small mute' }, t('pool.body')),
    R.validators.slice(0, 8).map((v) => h('button', { class: 'pool', onclick: () => onPick(v) },
      h('span', { class: 'pool-dot', style: `background:${v.color}` }, v.name.slice(0, 1)),
      h('span', { class: 'pool-main' }, h('b', {}, v.name),
        h('span', { class: 'tiny mute' }, [v.fee !== null ? t('pool.fee', { fee: fmtPct(v.fee) }) : '', v.schedule].filter(Boolean).join(' · ')))))));
}

function sheetShare(goal) {
  const link = `${APP_URL}?jar=${J.encodeJar({ id: goal.id, name: goal.name, target: goal.target, date: goal.date, owner: st.address, net: R.network })}`;
  const box = h('input', { type: 'text', readonly: true, value: link, onclick: (e) => e.target.select(), 'data-rig': 'share-link' });
  const copy = async () => {
    const ok = await copyText(link);
    toast(ok ? t('share.copied') : t('share.select'), ok ? 'good' : 'info');
    if (!ok) box.select();
  };
  const native = typeof navigator.share === 'function'
    ? h('button', { class: 'btn wide', onclick: () => navigator.share({ title: goal.name, text: t('share.text', { name: goal.name }), url: link }).catch(() => {}) }, t('share.system'))
    : null;
  openSheet(t('share.title'), h('div', { class: 'form' },
    h('p', { class: 'small' }, t('share.body')),
    field(t('share.link'), box),
    h('button', { class: 'btn primary wide', 'data-rig': 'share-copy', onclick: copy }, icon('link', 18), t('share.copy')),
    native,
    h('p', { class: 'tiny mute' }, t('share.note', { address: shortAddress(st.address) }))));
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
  const amount = h('input', { type: 'text', inputmode: 'decimal', value: String(suggested / LUNA), autocomplete: 'off', 'data-rig': 'w-amount' });
  const msg = h('div', {});
  const btn = h('button', { class: 'btn danger wide', 'data-rig': 'w-submit' }, t('wd.start'));
  const check = () => {
    const luna = toLuna(amount.value);
    const res = luna ? S.checkWithdraw(luna, staker) : { ok: false, reason: 'invalid' };
    const kids = [];
    if (res.reason === 'dust') {
      kids.push(h('p', { class: 'tiny warn' }, t('wd.dust')));
      kids.push(h('div', { class: 'quick' },
        h('button', { type: 'button', class: 'chip-btn', onclick: () => { amount.value = String(res.all / LUNA); check(); } }, t('wd.all', { amount: nim(res.all) })),
        res.max > 0 ? h('button', { type: 'button', class: 'chip-btn', onclick: () => { amount.value = String(res.max / LUNA); check(); } }, t('wd.leave', { amount: nim(res.max) })) : null));
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

function viewJar() {
  const jar = R.jar;
  const gifts = R.gifts;
  const total = (gifts || []).reduce((sum, g) => sum + g.luna, 0);
  const inside = W.inHost() || DEMO;
  const wrongNet = inside && jar.net !== R.network;
  const mine = st.address === jar.owner;
  const memoFor = (note) => J.buildMemo(jar.id, note);
  const amount = h('input', { type: 'text', inputmode: 'decimal', placeholder: '100', autocomplete: 'off', 'data-rig': 'j-amount' });
  const note = h('input', { type: 'text', maxlength: 40, placeholder: t('jar.notePh'), autocomplete: 'off', 'data-rig': 'j-note' });
  const err = h('p', { class: 'tiny bad' });
  const btn = h('button', { class: 'btn primary wide', 'data-rig': 'j-send' }, t('jar.send'));
  let sending = false;
  btn.addEventListener('click', async () => {
    if (sending) return;
    const luna = toLuna(amount.value);
    if (!luna) { err.textContent = t('form.errAmount'); return; }
    err.textContent = '';
    sending = true;
    btn.disabled = true;
    btn.textContent = t('save.waiting');
    try {
      const provider = W.getProvider();
      if (!(await ensureFresh())) throw Object.assign(new Error('not connected'), { handled: true });
      if (st.address === jar.owner) throw Object.assign(new Error('own jar'), { handled: true, text: t('jar.mine') });
      if (R.spendable !== null && luna > R.spendable) throw Object.assign(new Error('too much'), { handled: true, text: t('save.tooMuch', { amount: nim(R.spendable) }) });
      const hash = await provider.sendBasicTransactionWithData({ recipient: jar.owner, value: luna, data: memoFor(note.value) });
      toast(t('jar.sent'), 'good');
      await C.waitForTx(hash);
      await loadJarGifts();
      renderJarDone(luna);
      return;
    } catch (e) {
      if (e.text) err.textContent = e.text;
      else if (!e.handled) walletFailure(e);
    }
    sending = false;
    btn.disabled = false;
    btn.textContent = t('jar.send');
  });

  const giftRows = gifts === null
    ? h('div', { class: 'skeleton w60' })
    : gifts.length
      ? gifts.slice(0, 8).map((g) => h('div', { class: 'entry' },
        h('div', {}, h('div', { class: 'small' }, g.note || t('entry.gift')), h('div', { class: 'tiny mute' }, `${day(g.at)} · ${shortAddress(g.from)}`)),
        h('div', { class: 'entry-v' }, `+${nim(g.luna)}`)))
      : h('p', { class: 'small mute' }, t('jar.none'));

  const payBox = inside
    ? wrongNet
      ? h('section', { class: 'card notice' }, h('div', { class: 'notice-i' }, icon('info')), h('div', { class: 'small' }, t('jar.wrongNet')))
      : mine
        ? h('section', { class: 'card' }, h('p', { class: 'small' }, t('jar.mine')), h('a', { class: 'btn wide', href: `${location.pathname}${DEMO ? '?demo=1' : ''}#/goal/${jar.id}` }, t('jar.open')))
        : h('section', { class: 'card form' },
          h('h3', {}, t('jar.addTitle')),
          field(t('jar.amount'), amount),
          h('div', { class: 'quick' }, [100, 1000, 5000].map((n) => h('button', { type: 'button', class: 'chip-btn', onclick: () => { amount.value = String(n); } }, fmtNim(n * LUNA, lang())))),
          field(t('jar.note'), note),
          h('p', { class: 'tiny mute' }, t('jar.public')),
          err, btn,
          h('p', { class: 'tiny mute center' }, t('jar.direct', { address: shortAddress(jar.owner) })))
    : h('section', { class: 'card form' },
      h('h3', {}, t('jar.addTitle')),
      h('a', { class: 'btn primary wide', href: openInPay(location.href) }, t('outside.open')),
      h('p', { class: 'small' }, t('jar.anyWallet')),
      h('code', { class: 'mono' }, jar.owner),
      h('p', { class: 'tiny mute' }, t('jar.withMsg')),
      h('code', { class: 'mono' }, memoFor('')));

  const ratio = Math.min(1, total / jar.target);
  return chrome(h('main', { 'data-rig': 'jar' },
    h('section', { class: 'goal-hero' },
      hexRing(ratio, 140, h('div', {}, h('div', { class: 'gi' }, icon('gift', 26)), h('div', { class: 'pct' }, `${nim(total, 0)}`)), { width: 6 }),
      h('p', { class: 'small mute' }, t('jar.from', { address: shortAddress(jar.owner) })),
      h('h1', {}, jar.name),
      h('div', { class: 'mute' }, t('jar.target', { amount: nim(jar.target) })),
      jar.date ? h('div', { class: 'tiny mute' }, t('goal.by', { date: dateText(jar.date) })) : null),
    payBox,
    h('section', { class: 'card' }, h('h3', {}, t('jar.gifts')), giftRows),
    inside ? h('a', { class: 'btn wide', href: location.pathname + (DEMO ? '?demo=1' : ''), 'data-rig': 'j-own' }, t('jar.own')) : null,
    h('p', { class: 'tiny mute center' }, t('jar.how'))));
}

function renderJarDone(luna) {
  root().replaceChildren(chrome(h('main', {},
    h('section', { class: 'goal-hero' },
      h('div', { class: 'welcome-mark' }, logo(84)),
      h('h1', {}, t('jar.thanks')),
      h('p', { class: 'mute' }, t('jar.thanksBody', { amount: nim(luna), name: R.jar.name }))),
    h('a', { class: 'btn primary wide', href: location.pathname + (DEMO ? '?demo=1' : ''), 'data-rig': 'j-own' }, t('jar.own')))));
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

function openInPay(url) {
  return `nimiqpay://miniapp?url=${encodeURIComponent(url)}`;
}

function viewOutside() {
  return h('div', { class: 'page' },
    h('main', { class: 'welcome' },
      h('div', { class: 'welcome-mark' }, logo(84)),
      h('h1', {}, t('welcome.title')),
      h('p', { class: 'lead' }, t('outside.sub')),
      h('a', { class: 'btn primary wide', href: openInPay(location.href), 'data-rig': 'open-pay' }, t('outside.open')),
      h('p', { class: 'small center' }, t('outside.manual')),
      h('code', { class: 'mono center' }, APP_URL),
      h('a', { class: 'btn wide', href: `${location.pathname}?demo=1`, 'data-rig': 'demo' }, t('outside.demo')),
      h('p', { class: 'tiny mute center' }, t('outside.demoNote')),
      h('p', { class: 'center small' }, h('a', { href: REPO, target: '_blank', rel: 'noopener noreferrer' }, t('how.code')))));
}

/* ---------- router and boot ---------- */

function render() {
  const el = root();
  const scroll = window.scrollY;
  const hash = location.hash;
  let view;
  if (R.jar) view = viewJar();
  else if (!W.inHost() && !DEMO) view = viewOutside();
  else if (hash === '#/how') view = viewHow();
  else if (!st.address) view = viewWelcome();
  else if (hash.startsWith('#/goal/')) view = viewGoal(findGoal(hash.slice(7)));
  else view = viewHome();
  el.replaceChildren(view);
  document.documentElement.lang = lang();
  if (el.dataset.hash === hash) window.scrollTo(0, scroll);
  else window.scrollTo(0, 0);
  el.dataset.hash = hash;
}

function fatal() {
  root().replaceChildren(h('div', { class: 'page' }, h('main', { class: 'welcome' },
    h('div', { class: 'welcome-mark' }, logo(84)),
    h('h1', {}, t('fatal.title')),
    h('p', { class: 'lead' }, t('fatal.body')),
    h('button', { class: 'btn primary wide', onclick: () => location.reload() }, t('fatal.retry')))));
}

async function boot() {
  if (DEMO) {
    const mock = await import('./mock.js');
    mock.install();
  }
  R.network = W.hostNetwork();
  R.fiat = W.hostFiat();
  C.useNetwork(R.network);

  const jarParam = params.get('jar');
  if (jarParam) {
    R.jar = J.decodeJar(jarParam);
    if (R.jar && !W.inHost() && !DEMO) {
      R.network = R.jar.net;
      C.useNetwork(R.network);
    }
    if (!R.jar) toast(t('jar.bad'), 'bad', 6000);
  }

  st = loadState();
  setLang(st.lang || pickLang(W.hostLanguage() || navigator.language));
  render();

  window.addEventListener('hashchange', render);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });

  loadExtras().catch(() => {});

  if (W.inHost() || DEMO) {
    try {
      await W.connectProvider(5000);
    } catch {
      return fatal();
    }
  }
  if (R.jar) {
    await loadJarGifts();
    render();
    return undefined;
  }
  if (st.address) {
    await sync();
    setInterval(() => { if (!document.hidden && !sheetOpen()) sync(); }, 30e3);
  }
  return undefined;
}

window.addEventListener('error', () => { if (!root()?.children.length || root().querySelector('.boot')) fatal(); });
window.addEventListener('unhandledrejection', (e) => { console.warn('unhandled', e.reason?.message); });

boot().catch(() => fatal());
