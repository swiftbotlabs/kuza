// Spending what a goal saved: checking a Bitcoin Lightning invoice before Nimiq Pay is asked to pay it.
// Nimiq Pay does the paying (payLightningInvoice in its mini-app API): it decodes the invoice, asks the user to choose
// NIM or USDT and approve a self-custodial swap. Kuza only passes the invoice on, so this is a first, friendly check:
// the wallet checks it again and is the one that decides.

const BECH32 = '[02-9ac-hj-np-z]';
const BOLT11 = new RegExp(`^(lnbcrt|lntbs|lntb|lnbc)(\\d+[munp]?)?1${BECH32}{50,}$`);
const LNURL = new RegExp(`^lnurl1${BECH32}{20,}$`);
const MAX_LEN = 2048;

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

/**
 * Clean up what the user pasted and say whether it's worth handing to the wallet.
 * Returns { ok: true, invoice, kind: 'bolt11' | 'lnurl', sats } or { ok: false, reason }:
 *   empty, long, notLightning, wrongNet (a test invoice on mainnet or the other way round), noAmount (Nimiq Pay only
 *   pays invoices that name an amount).
 */
export function checkInvoice(input, network = 'mainnet') {
  if (typeof input !== 'string') return { ok: false, reason: 'empty' };
  const text = input.replace(/\s+/g, '').replace(/^lightning:/i, '').toLowerCase();
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > MAX_LEN) return { ok: false, reason: 'long' };
  if (LNURL.test(text)) return { ok: true, invoice: text, kind: 'lnurl', sats: null };
  const m = BOLT11.exec(text);
  if (!m) return { ok: false, reason: 'notLightning' };
  const test = m[1] !== 'lnbc';
  if (test !== (network === 'testnet')) return { ok: false, reason: 'wrongNet' };
  if (!m[2]) return { ok: false, reason: 'noAmount' };
  const sats = bolt11Sats(m[2]);
  if (sats === null || !(sats > 0)) return { ok: false, reason: 'notLightning' };
  return { ok: true, invoice: text, kind: 'bolt11', sats };
}
