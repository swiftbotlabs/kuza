// Demo mode: a pretend wallet and chain so the app can be tried outside Nimiq Pay.
// Loaded only with ?demo=1. Nothing here touches a real network, and the app shows a banner while it runs.

import { useBackend } from './chain.js';
import { h } from './ui.js';
import { MIN_STAKE, BLOCKS_PER_EPOCH, electionBlockAfter, releaseBlock, STAKING_CONTRACT } from './staking.js';
import { addressHex, normalizeAddress } from './nim.js';
import { sanitizeState, totalPrincipal } from './goals.js';

const LUNA = 100000;
const ME = 'NQ49 DEMA 0000 0000 0000 0000 0000 0000 0001';
const FRIEND = 'NQ22 DEMA 0000 0000 0000 0000 0000 0000 0002';
const START_HEIGHT = 65800000;
const START_WALLET = 25000 * LUNA;
const POOL = 'NQ08 RS08 LTKL 62QL B954 S9YP 0G3R XVKM RU2Y'; // the first pool of data/validators-main.json
const chain = {
  height: START_HEIGHT,
  wallet: START_WALLET, // the pretend owner's wallet
  friendWallet: START_WALLET, // the pretend friend's, who opens the owner's invite link
  staker: null,
  txs: new Map(),
  history: [],
  tickAt: 0,
};

/** Opening someone's invite link means being the friend, so the pretend wallet changes hands. */
const me = () => (/[?&](jar|j)=/.test(location.search) ? FRIEND : ME);

// One pretend chain per browser, kept beside the demo's goals (localStorage, demo only), so every tab, a reload and a
// new page all read the same wallet, stake, cooling-off and history as the goals that were booked against them.
// Each tab takes the latest copy before it reads or changes anything (pull), and writes it straight back.
// Settings > Reset demo clears it with the goals.
export const CHAIN_KEY = 'kuza.demo.chain';
const SAVED_MAX = 256 * 1024; // characters; a demo tab never comes close
const HISTORY_MAX = 300;
const isLuna = (n) => Number.isSafeInteger(n) && n >= 0;
const isAddr = (a) => typeof a === 'string' && a.length <= 64;
const isHex = (x, max) => typeof x === 'string' && x.length <= max && /^[0-9a-f]*$/i.test(x);

/** A stored transaction, rebuilt field by field; null if anything is off. */
function cleanTx(tx) {
  if (!tx || typeof tx !== 'object' || !/^[0-9a-f]{64}$/.test(tx.hash) || !isLuna(tx.blockNumber) || !isLuna(tx.timestamp)
    || typeof tx.executionResult !== 'boolean' || !isAddr(tx.from) || !isAddr(tx.to) || !isLuna(tx.value) || !isHex(tx.recipientData, 1024)) return null;
  const out = { hash: tx.hash, blockNumber: tx.blockNumber, timestamp: tx.timestamp, executionResult: tx.executionResult, from: tx.from, to: tx.to, value: tx.value, recipientData: tx.recipientData };
  if (tx.senderData !== undefined) {
    if (!isHex(tx.senderData, 64)) return null;
    out.senderData = tx.senderData;
  }
  if (tx.relatedAddresses !== undefined) {
    if (!Array.isArray(tx.relatedAddresses) || tx.relatedAddresses.length > 4 || !tx.relatedAddresses.every(isAddr)) return null;
    out.relatedAddresses = [...tx.relatedAddresses];
  }
  return out;
}

function cleanStaker(s) {
  if (s === null) return null;
  if (!s || typeof s !== 'object' || !isLuna(s.balance) || !isLuna(s.inactiveBalance) || !isLuna(s.retiredBalance)
    || !(s.inactiveFrom === null || isLuna(s.inactiveFrom)) || !isAddr(s.delegation)) return undefined;
  return { balance: s.balance, inactiveBalance: s.inactiveBalance, retiredBalance: s.retiredBalance, inactiveFrom: s.inactiveFrom, delegation: s.delegation };
}

let wiped = false;
let lastRaw = null; // the saved copy this tab last read or wrote

/** Settings > Reset demo: forget the saved chain, and stop saving it, so the reload that follows starts fresh. */
export function wipe() {
  wiped = true;
  try {
    localStorage.removeItem(CHAIN_KEY);
    sessionStorage.removeItem(CHAIN_KEY);
    sessionStorage.removeItem('kuza.demo.seed');
  } catch { /* storage off: nothing was kept */ }
}

function saveChain() {
  if (wiped) return;
  try {
    const raw = JSON.stringify({ v: 1, height: chain.height, wallet: chain.wallet, friendWallet: chain.friendWallet, staker: chain.staker, history: chain.history.slice(0, HISTORY_MAX), tickAt: chain.tickAt });
    localStorage.setItem(CHAIN_KEY, raw);
    lastRaw = raw;
  } catch { /* storage off or full: the demo still runs, it just starts over on a reload */ }
}

function startOver() {
  chain.height = START_HEIGHT;
  chain.wallet = START_WALLET;
  chain.friendWallet = START_WALLET;
  chain.staker = null;
  chain.history = [];
  chain.txs = new Map();
  chain.tickAt = 0;
}

/** Puts back a saved chain. Anything malformed is ignored as a whole (false) and nothing changes. */
function restoreChain(raw) {
  let saved;
  try {
    if (!raw || typeof raw !== 'string' || raw.length > SAVED_MAX) return false;
    saved = JSON.parse(raw);
  } catch { return false; }
  if (!saved || saved.v !== 1 || !isLuna(saved.height) || !isLuna(saved.wallet) || !Array.isArray(saved.history) || saved.history.length > HISTORY_MAX) return false;
  if (saved.friendWallet !== undefined && !isLuna(saved.friendWallet)) return false;
  if (saved.tickAt !== undefined && !isLuna(saved.tickAt)) return false;
  const staker = cleanStaker(saved.staker);
  if (staker === undefined) return false;
  const history = saved.history.map(cleanTx);
  if (history.includes(null)) return false;
  chain.height = saved.height;
  chain.wallet = saved.wallet;
  chain.friendWallet = saved.friendWallet ?? START_WALLET;
  chain.tickAt = saved.tickAt ?? 0;
  chain.staker = staker;
  chain.history = history;
  chain.txs = new Map(history.map((tx) => [tx.hash, tx]));
  return true;
}

/**
 * Takes the copy another tab of this browser saved, if it changed, before anything is read or changed here. A new
 * transaction from another tab (a friend's gift sent there) is announced to the app with a 'kuza-demo-chain' event.
 */
function pull() {
  if (wiped) return;
  let raw;
  try { raw = localStorage.getItem(CHAIN_KEY); } catch { return; }
  if (raw === lastRaw) return;
  const top = chain.history[0]?.hash;
  if (raw === null) {
    // Gone: Settings > Reset demo in another tab (the goals go too), or storage cleared. Start as a new page would.
    startOver();
    rebuildFromGoals();
    saveChain();
  } else if (!restoreChain(raw)) return; // damaged: this tab's copy stands and replaces it on the next save
  else lastRaw = raw;
  if (chain.history[0]?.hash !== top) dispatchEvent(new Event('kuza-demo-chain'));
}

/** The pretend owner's goals as the app keeps them (the friend's tab keeps its own), or null. */
function ownerGoals() {
  for (const key of ['kuza.demo.mainnet', `kuza.demo.mainnet.${ME.replace(/\s/g, '')}`]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw || raw.length > 2 * SAVED_MAX) continue;
      const s = sanitizeState(JSON.parse(raw));
      if (s.address === ME) return s;
    } catch { /* not readable: try the next */ }
  }
  return null;
}

/**
 * A browser with demo goals but no readable pretend chain (cleared, damaged, or kept per tab by an older version):
 * the chain is rebuilt from what the goals booked, a stake of that size, made by one deposit, so the stake, the
 * cooling-off and Earned (0) all agree with the goals instead of reading as "no stake".
 */
function rebuildFromGoals() {
  const s = ownerGoals();
  if (!s) return;
  const staked = (Number.isSafeInteger(s.baseline) && s.baseline > 0 ? s.baseline : 0) + totalPrincipal(s.goals);
  if (!isLuna(staked) || staked < MIN_STAKE || staked > chain.wallet) return;
  const delegation = normalizeAddress(s.validator || '') || POOL;
  const cooling = s.unstake && isLuna(s.unstake.amount) ? Math.min(s.unstake.amount, staked) : 0;
  chain.wallet -= staked;
  chain.staker = { balance: staked - cooling, inactiveBalance: cooling, retiredBalance: 0, inactiveFrom: cooling ? electionBlockAfter(chain.height) : null, delegation };
  mine({ to: STAKING_CONTRACT, value: staked, recipientData: `0501${addressHex(delegation) || ''}`, relatedAddresses: [STAKING_CONTRACT, ME, delegation] });
}

function ask(title, lines) {
  return new Promise((resolve, reject) => {
    const close = (ok) => {
      wrap.remove();
      if (ok && chain.failNext) {
        const err = chain.failNext;
        chain.failNext = null;
        reject(err);
      } else if (ok) resolve();
      else reject(Object.assign(new Error('User rejected the request.'), { type: 'PERMISSION_DENIED', code: 4001 }));
    };
    const wrap = h('div', { class: 'shade', style: 'z-index:60;position:fixed' },
      h('div', { class: 'sheet' },
        h('div', { class: 'sheet-head' }, h('h2', {}, title)),
        h('div', { class: 'sheet-body form' },
          h('p', { class: 'tiny mute' }, 'Pretend wallet. In Nimiq Pay this is a native approval sheet.'),
          lines.map((l) => h('p', { class: 'small' }, l)),
          h('button', { class: 'btn primary wide', 'data-rig': 'demo-yes', onclick: () => close(true) }, 'Confirm'),
          h('button', { class: 'btn wide', 'data-rig': 'demo-no', onclick: () => close(false) }, 'Reject'))));
    document.body.append(wrap);
  });
}

function mine(fields) {
  const hash = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const tx = { hash, blockNumber: chain.height + 2, timestamp: Date.now(), executionResult: true, from: ME, to: ME, value: 0, recipientData: '', ...fields };
  chain.txs.set(hash, tx);
  chain.history.unshift(tx);
  saveChain();
  return hash;
}

const fail = (message) => Object.assign(new Error(message), { type: 'INTERNAL_ERROR', code: -32603 });
const listeners = new Map();

const provider = {
  isConsensusEstablished: async () => true,
  getBlockNumber: async () => chain.height,
  getBalance: async () => {
    // A test can make the read fail, as a slow or broken wallet would.
    if (chain.balanceFails) throw new Error('Request timed out');
    pull();
    return me() === FRIEND ? chain.friendWallet : chain.wallet;
  },
  listAccounts: async () => {
    const who = me();
    await ask('Connect to Kuza', [`See your address ${who.slice(0, 9)}…`]);
    return [who];
  },
  disconnect() {},
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
  },
  async payLightningInvoice({ invoice }) {
    await ask('Pay with Bitcoin Lightning', [`${String(invoice).slice(0, 26)}…`, 'Pay with: NIM', 'Pretend swap, pretend shop.']);
    pull();
    chain.pays = (chain.pays || 0) + 1;
    const value = 4200 * LUNA;
    chain.wallet -= value;
    return { hash: mine({ to: 'NQ44 DEMA 0000 0000 0000 0000 0000 0000 0009', value }), swapId: 'demo-swap' };
  },
  async sendNewStakerTransaction({ delegation, value }) {
    await ask('Confirm Transaction', ['Create Staker', `${value / LUNA} NIM`]);
    pull();
    chain.creates = (chain.creates || 0) + 1;
    if (value < MIN_STAKE || chain.staker) throw fail('this would jam a real wallet');
    chain.wallet -= value;
    chain.staker = { balance: value, inactiveBalance: 0, retiredBalance: 0, inactiveFrom: null, delegation };
    return mine({ to: STAKING_CONTRACT, value, recipientData: `0501${addressHex(delegation) || ''}`, relatedAddresses: [STAKING_CONTRACT, ME, delegation] });
  },
  async sendStakeTransaction({ value }) {
    await ask('Confirm Transaction', ['Add Stake', `${value / LUNA} NIM`]);
    pull();
    chain.wallet -= value;
    chain.staker.balance += value;
    return mine({ to: STAKING_CONTRACT, value, recipientData: `06${addressHex(ME)}`, relatedAddresses: [STAKING_CONTRACT, ME] });
  },
  async sendSetActiveStakeTransaction({ newActiveBalance }) {
    await ask('Confirm Transaction', ['Set Active Stake', `${newActiveBalance / LUNA} NIM`]);
    pull();
    const s = chain.staker;
    const all = s.balance + s.inactiveBalance;
    s.balance = newActiveBalance;
    s.inactiveBalance = all - newActiveBalance;
    s.inactiveFrom = s.inactiveBalance ? electionBlockAfter(chain.height) : null;
    return mine({ to: STAKING_CONTRACT, recipientData: '08', relatedAddresses: [STAKING_CONTRACT, ME] });
  },
  async sendRetireStakeTransaction({ retireStake }) {
    await ask('Confirm Transaction', ['Retire Stake', `${retireStake / LUNA} NIM`]);
    pull();
    const s = chain.staker;
    if (chain.height < releaseBlock(s.inactiveFrom)) throw fail('still cooling off');
    s.inactiveBalance -= retireStake;
    s.retiredBalance += retireStake;
    if (!s.inactiveBalance) s.inactiveFrom = null;
    return mine({ to: STAKING_CONTRACT, recipientData: '09', relatedAddresses: [STAKING_CONTRACT, ME] });
  },
  async sendRemoveStakeTransaction({ value }) {
    await ask('Confirm Transaction', ['Remove Stake', `${value / LUNA} NIM`]);
    pull();
    const s = chain.staker;
    s.retiredBalance -= value;
    chain.wallet += value;
    if (!s.balance && !s.inactiveBalance && !s.retiredBalance) chain.staker = null;
    return mine({ from: STAKING_CONTRACT, to: ME, value, senderData: '01', relatedAddresses: [STAKING_CONTRACT, ME] });
  },
  async sendBasicTransactionWithData({ recipient, value, data }) {
    await ask('Confirm Transaction', [`Send ${value / LUNA} NIM`, recipient, `Message: ${data}`]);
    pull();
    // From whoever holds the pretend wallet now (the friend, on an invite link), into the other pretend wallet.
    const from = me();
    if (from === FRIEND) chain.friendWallet -= value;
    else chain.wallet -= value;
    if (recipient === ME && from !== ME) chain.wallet += value;
    else if (recipient === FRIEND && from !== FRIEND) chain.friendWallet += value;
    return mine({ from, to: recipient, value, recipientData: [...new TextEncoder().encode(data)].map((b) => b.toString(16).padStart(2, '0')).join('') });
  },
};

function backend(method, params) {
  if (chain.offline) throw new Error('offline');
  pull();
  switch (method) {
    case 'getBlockNumber': return chain.height;
    case 'getStakerByAddress':
      if (!chain.staker) throw Object.assign(new Error(`No staker with address: ${params[0]}`), { answer: true });
      return { address: params[0], ...chain.staker };
    case 'getTransactionByHash': {
      const tx = chain.txs.get(params[0]);
      if (!tx) throw Object.assign(new Error('Transaction not found'), { answer: true });
      return tx;
    }
    case 'getTransactionsByAddress':
      if (chain.historyFails) throw new Error('history unavailable'); // a test can make the history unreadable
      return chain.history.filter((t) => t.to === params[0] || t.from === params[0]);
    case 'getValidatorByAddress': return { address: params[0], jailedFrom: null, retired: false };
    case 'getAccountByAddress': return { address: params[0], balance: 0, type: 'basic' };
    default: throw new Error(`demo: ${method}`);
  }
}

export function install() {
  window.nimiq = provider;
  window.nimiqPay = { language: new URLSearchParams(location.search).get('lang') || navigator.language.slice(0, 2), userFiat: 'USD', network: 'mainnet' };
  useBackend(async (method, params) => {
    await new Promise((r) => setTimeout(r, 120));
    return backend(method, params);
  });
  let raw = null;
  try { raw = localStorage.getItem(CHAIN_KEY); } catch { /* storage off */ }
  if (restoreChain(raw)) lastRaw = raw;
  else {
    // An older version kept the chain per tab: carry this tab's copy over once, else rebuild from the goals.
    let old = null;
    try { old = sessionStorage.getItem(CHAIN_KEY); sessionStorage.removeItem(CHAIN_KEY); } catch { /* storage off */ }
    if (!restoreChain(old)) rebuildFromGoals();
    saveChain();
  }
  // Tests can seed gifts for the next page load (sessionStorage, demo only): [{ luna, memo }]. They go on the chain
  // once and are then kept with it, so the seed is used up.
  try {
    const seed = sessionStorage.getItem('kuza.demo.seed');
    if (seed) {
      sessionStorage.removeItem('kuza.demo.seed');
      for (const g of JSON.parse(seed).slice(0, 20)) {
        const data = [...new TextEncoder().encode(String(g.memo).slice(0, 64))].map((b) => b.toString(16).padStart(2, '0')).join('');
        mine({ from: FRIEND, to: ME, value: isLuna(Number(g.luna)) ? Number(g.luna) : 0, recipientData: data });
      }
    }
  } catch { /* no seed */ }
  // One block a second for the whole browser: with several tabs open, whichever ticks first moves the chain.
  setInterval(() => {
    pull();
    const gap = Date.now() - chain.tickAt;
    if (gap >= 0 && gap < 900) return; // another tab just moved it (a clock set back always ticks)
    chain.tickAt = Date.now();
    chain.height += 1;
    if (chain.staker && chain.staker.balance && !chain.noGrowth) chain.staker.balance += Math.ceil(chain.staker.balance * 2.5e-9);
    saveChain();
  }, 1000);
  addEventListener('storage', (e) => { if (e.key === CHAIN_KEY || e.key === null) pull(); });
  window.__kuzaDemo = {
    skipCooling() { pull(); chain.height += 2 * BLOCKS_PER_EPOCH; saveChain(); },
    reward(luna) { pull(); if (chain.staker) chain.staker.balance += luna; saveChain(); },
    emit(event, ...args) { for (const fn of listeners.get(event) || []) fn(...args); },
    chain,
    failNext(type, code, message, data) { chain.failNext = Object.assign(new Error(message), { type, code, data }); },
    gift(luna, memo) {
      const data = [...new TextEncoder().encode(memo)].map((b) => b.toString(16).padStart(2, '0')).join('');
      pull();
      mine({ from: FRIEND, to: ME, value: luna, recipientData: data });
    },
  };
}
