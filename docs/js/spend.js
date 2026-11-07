// Spending what a goal saved: checking a Bitcoin Lightning invoice before Nimiq Pay is asked to pay it.
// Nimiq Pay does the paying (payLightningInvoice in its mini-app API): it decodes the invoice, asks the user to choose
// NIM or USDT and approve a self-custodial swap. Kuza only passes the invoice on, so this is a first, friendly check:
// the wallet checks it again and is the one that decides.

const BECH32 = '[02-9ac-hj-np-z]';
const BOLT11 = new RegExp(`^(lnbcrt|lntbs|lntb|lnbc)(\\d+[munp]?)?1${BECH32}{50,}$`);
const LNURL = new RegExp(`^lnurl1${BECH32}{20,}$`);
const MAX_LEN = 2048;
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i];
  }
  return chk >>> 0;
}

/** Is this a bech32 string with a correct checksum (BIP-173; BOLT11 and LNURL use it, without the 90-character limit)? */
export function bech32Valid(str) {
  if (typeof str !== 'string' || str !== str.toLowerCase() && str !== str.toUpperCase()) return false;
  const s = str.toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length) return false;
  const hrp = [...s.slice(0, pos)].map((c) => c.charCodeAt(0));
  if (hrp.some((c) => c < 33 || c > 126)) return false;
  const data = [];
  for (const c of s.slice(pos + 1)) {
    const d = CHARSET.indexOf(c);
    if (d < 0) return false;
    data.push(d);
  }
  return polymod([...hrp.map((c) => c >> 5), 0, ...hrp.map((c) => c & 31), ...data]) === 1;
}

/** BTC amount of a BOLT11 amount part (e.g. 2500u), in satoshis; null if it isn't a whole number of satoshis. */
export function bolt11Sats(part) {
  const m = /^(\d+)([munp]?)$/.exec(part || '');
  if (!m) return null;
  const n = BigInt(m[1]);
  // 1 BTC = 100,000,000 sat. m = 1e-3, u = 1e-6, n = 1e-9, p = 1e-12 BTC.
  const msat = { '': n * 100000000000n, m: n * 100000000n, u: n * 100000n, n: n * 100n, p: n / 10n }[m[2]];
  if (m[2] === 'p' && n % 10n !== 0n) return null;
  if (msat % 1000n !== 0n) return Number(msat) / 1000;
  const sats = msat / 1000n;
  return sats <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(sats) : null;
}

const SIG_WORDS = 104; // a BOLT11 signature: 65 bytes = 104 five-bit words, just before the checksum
const EXPIRY_TAG = 6; // 'x'
export const DEFAULT_EXPIRY = 3600; // seconds, when an invoice has no x field (BOLT11)

/**
 * When a BOLT11 invoice was made (Unix seconds, the 35 bits right after the separator) and how long it is good for
 * (its x field, 3600 s when it has none). Null when the text is too short to say.
 */
export function bolt11Times(invoice) {
  if (typeof invoice !== 'string') return null;
  const s = invoice.toLowerCase();
  const w = [...s.slice(s.lastIndexOf('1') + 1, -6)].map((c) => CHARSET.indexOf(c));
  if (w.length < 7 || w.some((x) => x < 0)) return null;
  const num = (list) => list.reduce((n, x) => n * 32 + x, 0);
  const ts = num(w.slice(0, 7));
  let expiry = DEFAULT_EXPIRY;
  const end = w.length - SIG_WORDS;
  for (let i = 7; i + 3 <= end;) {
    const type = w[i];
    const len = w[i + 1] * 32 + w[i + 2];
    if (i + 3 + len > end) break; // a field running into the signature: stop reading, keep what is known
    if (type === EXPIRY_TAG && len > 0) expiry = len > 7 ? Infinity : num(w.slice(i + 3, i + 3 + len));
    i += 3 + len;
  }
  return { ts, expiry };
}

/**
 * Clean up what the user pasted and say whether it's worth handing to the wallet.
 * Returns { ok: true, invoice, kind: 'bolt11' | 'lnurl', sats } or { ok: false, reason }:
 *   empty, long, notLightning, damaged (the checksum fails: a character changed or went missing on the way), wrongNet
 *   (a test invoice on mainnet or the other way round), noAmount (Nimiq Pay only pays invoices that name an amount),
 *   expired (its time plus its expiry, 1 hour by default, has passed: the shop needs to make a new one).
 */
export function checkInvoice(input, network = 'mainnet', now = Date.now()) {
  if (typeof input !== 'string') return { ok: false, reason: 'empty' };
  const text = input.replace(/\s+/g, '').replace(/^lightning:/i, '').toLowerCase();
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > MAX_LEN) return { ok: false, reason: 'long' };
  if (LNURL.test(text)) return bech32Valid(text) ? { ok: true, invoice: text, kind: 'lnurl', sats: null } : { ok: false, reason: 'damaged' };
  const m = BOLT11.exec(text);
  if (!m) return { ok: false, reason: 'notLightning' };
  if (!bech32Valid(text)) return { ok: false, reason: 'damaged' };
  const test = m[1] !== 'lnbc';
  if (test !== (network === 'testnet')) return { ok: false, reason: 'wrongNet' };
  if (!m[2]) return { ok: false, reason: 'noAmount' };
  const sats = bolt11Sats(m[2]);
  if (sats === null || !(sats > 0)) return { ok: false, reason: 'notLightning' };
  const times = bolt11Times(text);
  if (!times || now / 1000 > times.ts + times.expiry) return { ok: false, reason: 'expired' };
  return { ok: true, invoice: text, kind: 'bolt11', sats };
}
