// Kuza's public helper. It never touches money. It does three small things:
//  - counts unique wallets from a one-way hash, keyed again with a secret so the stored value can't be
//    matched to an address by hashing public addresses;
//  - serves a trimmed list of pools (the public list is 800 KB of embedded logos, too heavy for a phone);
//  - serves a NIM price and a network reward estimate, so the app doesn't call those services directly.
// No IP addresses, user agents or anything else about the caller are stored.

const ORIGINS = new Set(['https://swiftbotlab.github.io']);
const VALIDATORS = {
  main: 'https://validators-api-main.je-cf9.workers.dev/api/v1/validators',
  test: 'https://validators-api-test.je-cf9.workers.dev/api/v1/validators',
};
const SUPPLY = 'https://validators-api-main.je-cf9.workers.dev/api/v1/supply';
const PRICE = 'https://api.gateio.ws/api/v4/spot/tickers?currency_pair=NIM_USDT';
const FX = 'https://open.er-api.com/v6/latest/USD';
const HEX64 = /^[0-9a-f]{64}$/;
const DECAY_YEAR = 1 - Math.exp(-(1 - 0.9999999999960264) * 365.25 * 864e5);
const MAX_UPSTREAM = 4 * 1024 * 1024;
const PER_CALLER_HOUR = 12;

function cors(request) {
  const origin = request.headers.get('origin');
  const headers = { vary: 'origin', 'x-content-type-options': 'nosniff' };
  if (origin && ORIGINS.has(origin)) headers['access-control-allow-origin'] = origin;
  return headers;
}

function json(data, request, status = 200, extra = {}) {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors(request), ...extra },
  });
}

// Per-isolate limiter. Enough to blunt a loop; the counter also ignores repeats by design.
const hits = new Map();

function limited(request, max) {
  const ip = request.headers.get('cf-connecting-ip') || 'x';
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.t > 60e3) {
    if (hits.size > 5000) hits.clear();
    hits.set(ip, { t: now, n: 1 });
    return false;
  }
  rec.n += 1;
  return rec.n > max;
}

async function fetchJson(url, timeout = 8000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'follow', headers: { accept: 'application/json', 'user-agent': 'kuza-api' } });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_UPSTREAM) throw new Error('upstream too large');
  return JSON.parse(text);
}

function cached(request, ttl, build, usable = () => true) {
  return async (ctx) => {
    const cache = caches.default;
    const key = new Request(new URL(request.url).toString(), { method: 'GET' });
    const hit = await cache.match(key);
    let data;
    if (hit) data = await hit.json();
    else {
      data = await build();
      if (usable(data)) ctx.waitUntil(cache.put(key, new Response(JSON.stringify(data), { headers: { 'cache-control': `public, max-age=${ttl}`, 'content-type': 'application/json' } })));
    }
    return json(data, request, 200, { 'cache-control': `public, max-age=${Math.min(ttl, 300)}` });
  };
}

export function trimValidators(list) {
  if (!Array.isArray(list)) throw new Error('bad list');
  return list
    .filter((v) => v && v.isListed !== false && v.payoutType === 'restake' && typeof v.fee === 'number' && v.fee <= 0.1 && (v.score?.total ?? 0) >= 0.6)
    .map((v) => ({
      name: String(v.name || '').slice(0, 32),
      address: String(v.address || ''),
      fee: v.fee,
      score: Math.round((v.score?.total ?? 0) * 1000) / 1000,
      color: /^#[0-9a-fA-F]{6}$/.test(v.accentColor || '') ? v.accentColor : '#1f2348',
      schedule: /^[\w ,.:-]{0,32}$/.test(v.payoutSchedule || '') && !/\*/.test(v.payoutSchedule || '') ? v.payoutSchedule : '',
      share: typeof v.dominanceRatio === 'number' ? Math.round(v.dominanceRatio * 10000) / 10000 : null,
    }))
    .sort((a, b) => b.score - a.score || a.fee - b.fee)
    .slice(0, 12);
}

export function grossRate(supply) {
  const { total, staking, max } = supply || {};
  if (!(total > 0) || !(staking > 0) || !(max > total)) return null;
  return Math.round(((max - total) * DECAY_YEAR / staking) * 10000) / 10000;
}

/** NIM/USDT last trade, read as USD, then converted with daily FX rates. */
export function buildPrices(ticker, fx) {
  const usd = Number(Array.isArray(ticker) ? ticker[0]?.last : null);
  if (!(usd > 0)) return {};
  const out = { usd };
  for (const code of ['EUR', 'CRC', 'GMD']) {
    const rate = fx?.rates?.[code];
    if (rate > 0) out[code.toLowerCase()] = usd * rate;
  }
  return out;
}

async function secretKey(env) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(env.COUNT_SALT), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function hmacHex(env, text) {
  const sig = await crypto.subtle.sign('HMAC', await secretKey(env), new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class Counter {
  constructor(state) {
    this.sql = state.storage.sql;
    this.recent = new Map(); // memory only: new wallets per caller per hour, so one source can't inflate the count
    this.sql.exec('CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, day TEXT NOT NULL)');
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST') {
      const { id, caller } = await request.json();
      const now = Date.now();
      let rec = this.recent.get(caller);
      if (!rec || now - rec.t > 3600e3) {
        if (this.recent.size > 20000) this.recent.clear();
        rec = { t: now, n: 0 };
        this.recent.set(caller, rec);
      }
      rec.n += 1;
      if (rec.n <= PER_CALLER_HOUR) {
        this.sql.exec('INSERT OR IGNORE INTO seen (id, day) VALUES (?, ?)', id, new Date().toISOString().slice(0, 10));
      }
    }
    const wallets = this.sql.exec('SELECT COUNT(*) AS n FROM seen').one().n;
    if (url.pathname === '/days') {
      const days = this.sql.exec('SELECT day, COUNT(*) AS n FROM seen GROUP BY day ORDER BY day').toArray();
      return Response.json({ wallets, days });
    }
    return Response.json({ wallets });
  }
}

const counter = (env) => env.COUNTER.get(env.COUNTER.idFromName('wallets'));

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...cors(request), 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' } });
  }

  if (path === '/v1/seen') {
    if (request.method !== 'POST') return json({ error: 'method' }, request, 405);
    if (!ORIGINS.has(request.headers.get('origin'))) return json({ error: 'origin' }, request, 403);
    if (limited(request, 10)) return json({ error: 'slow down' }, request, 429);
    const text = await request.text();
    if (text.length > 200) return json({ error: 'too large' }, request, 413);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: 'bad json' }, request, 400);
    }
    if (!body || typeof body.h !== 'string' || !HEX64.test(body.h)) return json({ error: 'bad hash' }, request, 400);
    const [id, caller] = await Promise.all([hmacHex(env, body.h), hmacHex(env, `ip:${request.headers.get('cf-connecting-ip') || ''}`)]);
    await counter(env).fetch('https://do/seen', { method: 'POST', body: JSON.stringify({ id, caller }) });
    return json(null, request, 204);
  }

  if (request.method !== 'GET') return json({ error: 'method' }, request, 405);
  if (limited(request, 120)) return json({ error: 'slow down' }, request, 429);

  if (path === '/v1/stats') {
    const res = await counter(env).fetch('https://do/days');
    return json(await res.json(), request, 200, { 'cache-control': 'public, max-age=60' });
  }
  if (path === '/v1/validators') {
    const net = url.searchParams.get('net') === 'test' ? 'test' : 'main';
    const clean = new Request(`${url.origin}/v1/validators?net=${net}`);
    return cached(clean, 3600, async () => ({ validators: trimValidators(await fetchJson(VALIDATORS[net], 12000)), at: Date.now() }))(ctx).then((r) => {
      const out = new Response(r.body, r);
      for (const [k, v] of Object.entries(cors(request))) out.headers.set(k, v);
      return out;
    });
  }
  if (path === '/v1/market') {
    const clean = new Request(`${url.origin}/v1/market?v=2`);
    return cached(clean, 900, async () => {
      const [quote, fx, supply] = await Promise.allSettled([fetchJson(PRICE), fetchJson(FX), fetchJson(SUPPLY)]);
      const p = quote.status === 'fulfilled' ? buildPrices(quote.value, fx.status === 'fulfilled' ? fx.value : null) : {};
      const s = supply.status === 'fulfilled' ? supply.value : null;
      return { price: p, rate: grossRate(s), stakedRatio: s?.staking && s?.total ? Math.round((s.staking / s.total) * 1000) / 1000 : null, at: Date.now() };
    }, (d) => d.price.usd > 0 && d.rate)(ctx).then((r) => {
      const out = new Response(r.body, r);
      for (const [k, v] of Object.entries(cors(request))) out.headers.set(k, v);
      return out;
    });
  }
  if (path === '/') return json({ name: 'kuza-api', source: 'https://github.com/swiftbotlab/kuza' }, request);
  return json({ error: 'not found' }, request, 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch {
      return json({ error: 'unavailable' }, request, 503);
    }
  },
};
