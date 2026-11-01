// A thin layer over the provider Nimiq Pay injects.

import { init } from './vendor/mini-app-sdk.js';

let provider = null;

export const inHost = () => Boolean(window.nimiq || window.nimiqPay || window.__NIMIQ_PAY__);

export async function connectProvider(timeout = 4000) {
  if (!provider) provider = await init({ timeout });
  return provider;
}

export const getProvider = () => provider;

/** Sort a wallet error into something the UI can act on. Cancelling is normal, not a failure. */
export function classifyError(err) {
  const type = err?.type;
  const code = err?.code;
  if (type === 'PERMISSION_DENIED' || code === 4001) return 'cancel';
  if (type === 'TRANSACTION_OUTCOME_UNKNOWN' || code === -32001) return 'unknown';
  if (type === 'NETWORK_ERROR' || code === -32000) return 'network';
  if (type === 'INVALID_TRANSACTION' || type === 'INVALID_REQUEST' || code === -32602) return 'invalid';
  if (type === 'UNKNOWN_REQUEST' || code === 4200) return 'unsupported';
  if (/still pending|already in progress/i.test(err?.message || '')) return 'busy';
  return 'other';
}

export function errorHash(err) {
  const h = err?.data?.hash;
  return typeof h === 'string' && /^[0-9a-fA-F]{64}$/.test(h) ? h : null;
}

/**
 * Nimiq Pay pays out of its second account (a contract the wallet keeps), not the first one.
 * The first account is the permanent identity: it owns the stake and receives money, which the wallet
 * then moves across. So `spendable` is what a transaction can use right now, and `total` is everything.
 */
export async function walletBalances(accounts) {
  const parts = await Promise.all(accounts.map((a) => provider.getBalance(a).catch(() => null)));
  const known = parts.filter((p) => typeof p === 'number');
  if (!known.length) return { total: null, spendable: null };
  const payer = parts.length > 1 ? parts[1] : parts[0];
  return { total: known.reduce((x, y) => x + y, 0), spendable: typeof payer === 'number' ? payer : null };
}

export const hostLanguage = () => window.nimiqPay?.language || window.__NIMIQ_PAY__?.lang || null;
export const hostFiat = () => window.nimiqPay?.userFiat || window.__NIMIQ_PAY__?.userFiat || null;
export const hostNetwork = () => (window.nimiqPay?.network || window.__NIMIQ_PAY__?.network) === 'testnet' ? 'testnet' : 'mainnet';
