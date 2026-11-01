// Kuza's small public helper: wallet count, a trimmed validator list, price and an estimated reward rate.
// All of it is optional. If it's down the app carries on with what it has.

import { sha256Hex } from './nim.js';

export const API = 'https://kuza-api.swiftbotlab.workers.dev';

async function get(path, timeout = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(API + path, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), value }));
  } catch { /* private mode or full: just skip the cache */ }
}

function recall(key) {
  try {
    return JSON.parse(localStorage.getItem(key))?.value ?? null;
  } catch {
    return null;
  }
}

const VALIDATOR_RE = /^NQ\d{2}( [0-9A-HJ-NP-VXY]{4}){8}$/;

function cleanValidators(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((v) => v && typeof v.name === 'string' && VALIDATOR_RE.test(v.address))
    .map((v) => ({
      name: v.name.slice(0, 32),
      address: v.address,
      fee: typeof v.fee === 'number' && v.fee >= 0 && v.fee <= 1 ? v.fee : null,
      score: typeof v.score === 'number' ? v.score : null,
      color: /^#[0-9a-fA-F]{6}$/.test(v.color || '') ? v.color : '#1f2348',
      schedule: typeof v.schedule === 'string' ? v.schedule.slice(0, 32) : '',
    }));
}

/** The list shipped with the app, or the last one fetched. Instant, so the first stake never waits on a server. */
export async function localValidators(network) {
  const cached = recall(`kuza.validators.${network}`);
  if (cached?.length) return cleanValidators(cached);
  try {
    const res = await fetch(`data/validators-${network === 'testnet' ? 'test' : 'main'}.json`);
    return cleanValidators((await res.json()).validators);
  } catch {
    return [];
  }
}

/** Fresh pools that restake rewards, best first. Null if the helper can't be reached. */
export async function freshValidators(network) {
  try {
    const data = await get(`/v1/validators?net=${network === 'testnet' ? 'test' : 'main'}`);
    const list = cleanValidators(data.validators);
    if (list.length) {
      remember(`kuza.validators.${network}`, list);
      return list;
    }
  } catch { /* the local list stays in place */ }
  return null;
}

/** { price: {usd, eur, ...}, rate, stakedRatio } or null. */
export async function loadMarket() {
  const key = 'kuza.market';
  try {
    const data = await get('/v1/market');
    remember(key, data);
    return data;
  } catch {
    return recall(key);
  }
}

export async function loadStats() {
  try {
    const data = await get('/v1/stats', 4000);
    return Number.isSafeInteger(data.wallets) ? data : null;
  } catch {
    return null;
  }
}

/** Counts this wallet once. Only a one-way hash leaves the device, and never on testnet. */
export async function reportSeen(address) {
  const h = await sha256Hex(`kuza:v1:${address.replace(/\s/g, '')}`);
  await fetch(`${API}/v1/seen`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ h }),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
}
