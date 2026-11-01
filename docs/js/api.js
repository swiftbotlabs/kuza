// Kuza's small public helper: wallet count, a trimmed validator list, price and an estimated reward rate.
// All of it is optional. If it's down the app carries on with what it has.

import { sha256Hex, normalizeAddress } from './nim.js';
import { cleanText } from './jar.js';

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

function cleanValidators(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((v) => v && typeof v.name === 'string' && typeof v.address === 'string' && normalizeAddress(v.address))
    .map((v) => ({
      name: cleanText(v.name, 32),
      address: normalizeAddress(v.address),
      fee: typeof v.fee === 'number' && v.fee >= 0 && v.fee <= 1 ? v.fee : null,
      score: typeof v.score === 'number' ? v.score : null,
      color: /^#[0-9a-fA-F]{6}$/.test(v.color || '') ? v.color : '#1f2348',
      schedule: typeof v.schedule === 'string' ? cleanText(v.schedule, 32) : '',
    }))
    .filter((v) => v.name);
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

function cleanMarket(data) {
  const price = {};
  for (const [code, value] of Object.entries(data?.price || {})) {
    if (/^[a-z]{3}$/.test(code) && Number.isFinite(value) && value > 0) price[code] = value;
  }
  const rate = Number.isFinite(data?.rate) && data.rate > 0 && data.rate < 1 ? data.rate : null;
  return Object.keys(price).length || rate ? { price, rate } : null;
}

/** { price: {usd, eur, ...}, rate } or null. */
export async function loadMarket() {
  const key = 'kuza.market';
  try {
    const clean = cleanMarket(await get('/v1/market'));
    if (clean) {
      remember(key, clean);
      return clean;
    }
  } catch { /* fall back to the last good value */ }
  return cleanMarket(recall(key));
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
