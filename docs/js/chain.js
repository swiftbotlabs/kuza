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
    return body.result?.data;
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

export async function getValidator(address) {
  try {
    return await call('getValidatorByAddress', [address]);
  } catch (err) {
    if (err.answer) return null;
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
