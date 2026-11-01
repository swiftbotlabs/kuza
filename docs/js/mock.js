// Demo mode: a pretend wallet and chain so the app can be tried outside Nimiq Pay.
// Loaded only with ?demo=1. Nothing here touches a real network, and the app shows a banner while it runs.

import { useBackend } from './chain.js';
import { h } from './ui.js';
import { MIN_STAKE, BLOCKS_PER_EPOCH, electionBlockAfter, releaseBlock } from './staking.js';

const LUNA = 100000;
const ME = 'NQ43 Y1RH P1K7 JH78 LRTS 95RY GAUU UBDK FFGX';
const FRIEND = 'NQ15 HNAH YRVH DFVM YHAG BSXG 0QHK KA0Q XDR7';
const chain = {
  height: 65800000,
  wallet: 25000 * LUNA,
  staker: null,
  txs: new Map(),
  history: [],
};

function ask(title, lines) {
  return new Promise((resolve, reject) => {
    const close = (ok) => {
      wrap.remove();
      if (ok) resolve();
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
  return hash;
}

const fail = (message) => Object.assign(new Error(message), { type: 'INTERNAL_ERROR', code: -32603 });

const provider = {
  isConsensusEstablished: async () => true,
  getBlockNumber: async () => chain.height,
  getBalance: async () => chain.wallet,
  listAccounts: async () => {
    // Opening someone's invite link means being the friend, so the pretend wallet changes hands.
    const me = location.search.includes('jar=') ? FRIEND : ME;
    await ask('Connect to Kuza', [`See your address ${me.slice(0, 9)}…`]);
    return [me];
  },
  disconnect() {},
  async sendNewStakerTransaction({ delegation, value }) {
    await ask('Confirm Transaction', ['Create Staker', `${value / LUNA} NIM`]);
    if (value < MIN_STAKE) throw fail('below minimum');
    chain.wallet -= value;
    chain.staker = { balance: value, inactiveBalance: 0, retiredBalance: 0, inactiveFrom: null, delegation };
    return mine({ value });
  },
  async sendStakeTransaction({ value }) {
    await ask('Confirm Transaction', ['Add Stake', `${value / LUNA} NIM`]);
    chain.wallet -= value;
    chain.staker.balance += value;
    return mine({ value });
  },
  async sendSetActiveStakeTransaction({ newActiveBalance }) {
    await ask('Confirm Transaction', ['Set Active Stake', `${newActiveBalance / LUNA} NIM`]);
    const s = chain.staker;
    const all = s.balance + s.inactiveBalance;
    s.balance = newActiveBalance;
    s.inactiveBalance = all - newActiveBalance;
    s.inactiveFrom = s.inactiveBalance ? electionBlockAfter(chain.height) : null;
    return mine({});
  },
  async sendRetireStakeTransaction({ retireStake }) {
    await ask('Confirm Transaction', ['Retire Stake', `${retireStake / LUNA} NIM`]);
    const s = chain.staker;
    if (chain.height < releaseBlock(s.inactiveFrom)) throw fail('still cooling off');
    s.inactiveBalance -= retireStake;
    s.retiredBalance += retireStake;
    if (!s.inactiveBalance) s.inactiveFrom = null;
    return mine({});
  },
  async sendRemoveStakeTransaction({ value }) {
    await ask('Confirm Transaction', ['Remove Stake', `${value / LUNA} NIM`]);
    const s = chain.staker;
    s.retiredBalance -= value;
    chain.wallet += value;
    if (!s.balance && !s.inactiveBalance && !s.retiredBalance) chain.staker = null;
    return mine({ value });
  },
  async sendBasicTransactionWithData({ recipient, value, data }) {
    await ask('Confirm Transaction', [`Send ${value / LUNA} NIM`, recipient, `Message: ${data}`]);
    chain.wallet -= value;
    return mine({ to: recipient, value, recipientData: [...new TextEncoder().encode(data)].map((b) => b.toString(16).padStart(2, '0')).join('') });
  },
};

function backend(method, params) {
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
    case 'getTransactionsByAddress': return chain.history.filter((t) => t.to === params[0] || t.from === params[0]);
    case 'getValidatorByAddress': return { address: params[0], jailedFrom: null, retired: false };
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
  setInterval(() => {
    chain.height += 1;
    if (chain.staker && chain.staker.balance) chain.staker.balance += Math.ceil(chain.staker.balance * 2.5e-9);
  }, 1000);
  window.__kuzaDemo = {
    skipCooling() { chain.height += 2 * BLOCKS_PER_EPOCH; },
    chain,
    gift(luna, memo) {
      const data = [...new TextEncoder().encode(memo)].map((b) => b.toString(16).padStart(2, '0')).join('');
      mine({ from: FRIEND, to: ME, value: luna, recipientData: data });
    },
  };
}
