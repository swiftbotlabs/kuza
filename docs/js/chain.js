// Read-only access to the Nimiq chain over public JSON-RPC.
// Kuza never sends anything through here. Transactions only ever go through the wallet.

import { normalizeStaker } from './staking.js';

const RPC_URLS = {
  mainnet: 'https://rpc.nimiqwatch.com',
  testnet: 'https://rpc.testnet.nimiqwatch.com',
};

let network = 'mainnet';
let backend = null; // the demo swaps in a pretend chain

export function useNetwork(name) {
  network = RPC_URLS[name] ? name : 'mainnet';
}

export function useBackend(fn) {
  backend = fn;
}

export class RpcError extends Error {}

async function post(method, params, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(RPC_URLS[network], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (res.status === 429) throw new RpcError('rate limited');
    if (!res.ok) throw new RpcError(`http ${res.status}`);
    const body = await res.json();
    if (body.error) {
      const e = body.error;
      const text = typeof e === 'string' ? e : `${e.message || ''} ${e.data || ''}`;
      const err = new RpcError(text);
      err.answer = true; // the node answered; this isn't a connection problem
      throw err;
    }
    const data = body.result?.data;
    // An empty 200 must never read as "this address has no stake".
    if (data === undefined || data === null) throw new RpcError('empty answer');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function call(method, params = [], { timeout = 9000, retries = 1 } = {}) {
  if (backend) return backend(method, params);
  let lastError;
  for (let i = 0; i <= retries; i++) {
    try {
      return await post(method, params, timeout);
    } catch (err) {
      lastError = err;
      if (err.answer) throw err;
      if (i < retries) await new Promise((r) => setTimeout(r, 1200));
    }
  }
  throw lastError;
}

export async function getHeight() {
  return Number(await call('getBlockNumber'));
}

/** The staker, or null if this address has never staked. Connection errors still throw. */
export async function getStaker(address) {
  try {
    return normalizeStaker(await call('getStakerByAddress', [address]));
  } catch (err) {
    if (err.answer && /no staker/i.test(err.message)) return null;
    throw err;
  }
}

/** The transaction, or null while the node doesn't know it. */
export async function getTx(hash) {
  try {
    return await call('getTransactionByHash', [hash]);
  } catch (err) {
    if (err.answer && /not found/i.test(err.message)) return null;
    throw err;
  }
}

export async function getHistory(address, max = 100) {
  const list = await call('getTransactionsByAddress', [address, Math.min(max, 500), null], { timeout: 12000 });
  return Array.isArray(list) ? list : [];
}

const PAGE = 500;
const MAX_PAGES = 4;
const MAX_ACCOUNTS = 60;

/** Every transaction of an address, newest first, or a throw when it can't be read completely. */
export async function fullHistory(address) {
  const out = [];
  const seen = new Set();
  let startAt = null;
  for (let p = 0; p < MAX_PAGES; p++) {
    const page = await call('getTransactionsByAddress', [address, PAGE, startAt], { timeout: 12000 });
    if (!Array.isArray(page)) throw new RpcError('bad history');
    let fresh = 0;
    for (const tx of page) {
      if (tx && typeof tx.hash === 'string' && !seen.has(tx.hash)) { seen.add(tx.hash); out.push(tx); fresh++; }
    }
    if (page.length < PAGE) return out;
    if (!fresh) break;
    startAt = page[page.length - 1].hash;
  }
  throw new RpcError('history too long to read completely');
}

/**
 * The history behind a staker: the wallet address and every payment account (HTLC) it funded, plus the accounts the
 * wallet lists now. Nimiq Pay pays, and stakes, from those payment accounts. Throws if any part can't be read.
 * `cache` keeps the histories of old payment accounts, which see no new transactions once replaced.
 */
export async function walletStakeHistory(owner, accounts = [], cache = new Map()) {
  const own = await fullHistory(owner);
  const others = new Set(accounts.filter((a) => a && a !== owner));
  for (const tx of own) if (tx && tx.from === owner && tx.toType === 2 && typeof tx.to === 'string') others.add(tx.to);
  if (others.size > MAX_ACCOUNTS) throw new RpcError('too many accounts to read');
  const lists = [own];
  const todo = [...others];
  for (let i = 0; i < todo.length; i += 4) {
    lists.push(...await Promise.all(todo.slice(i, i + 4).map(async (a) => {
      if (cache.has(a)) return cache.get(a);
      const list = await fullHistory(a);
      const latest = Math.max(0, ...list.map((tx) => Number(tx.timestamp) || 0));
      if (!accounts.includes(a) && Date.now() - latest > 3600e3) cache.set(a, list);
      return list;
    })));
  }
  return lists.flat();
}

/** 'basic', 'htlc', 'staking' and so on. Null if the node doesn't say. */
export async function getAccountType(address) {
  const account = await call('getAccountByAddress', [address]);
  return typeof account?.type === 'string' ? account.type : null;
}

export async function getValidator(address) {
  try {
    return await call('getValidatorByAddress', [address]);
  } catch (err) {
    if (err.answer && /no validator/i.test(err.message)) return null;
    throw err;
  }
}

/** Wait until a transaction is mined. Resolves to the tx, or null if it hasn't shown up in time. */
export async function waitForTx(hash, { tries = 30, every = 3000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const tx = await getTx(hash).catch(() => null);
    if (tx && tx.blockNumber) return tx;
    await new Promise((r) => setTimeout(r, every));
  }
  return null;
}

export function explorerTx(hash) {
  const host = network === 'testnet' ? 'https://test.nimiq.watch' : 'https://nimiq.watch';
  return `${host}/#${hash}`;
}
