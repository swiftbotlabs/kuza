// Plain NIM helpers: amounts, addresses, hashing. No DOM, no network.

export const LUNA = 100000; // 1 NIM = 100,000 Luna
export const MAX_LUNA = 21e14; // total supply, 21 billion NIM

/** Parse a user-typed NIM amount into integer Luna, or null if it isn't one. */
export function toLuna(input) {
  if (typeof input === 'number') input = String(input);
  if (typeof input !== 'string') return null;
  const s = input.trim().replace(/\s/g, '').replace(',', '.');
  // "1,000" or "1.000" could mean a thousand or one: refuse rather than guess.
  if (/^[1-9]\d{0,2}[.,]\d{3}$/.test(input.trim())) return null;
  if (!/^\d{1,14}(\.\d{0,5})?$/.test(s) && !/^\.\d{1,5}$/.test(s)) return null;
  const [whole = '0', frac = ''] = s.split('.');
  const luna = Number(whole || '0') * LUNA + Number((frac + '00000').slice(0, 5));
  return Number.isSafeInteger(luna) && luna <= MAX_LUNA ? luna : null;
}

/** Text for an amount field that toLuna reads back exactly. */
export function plainNim(luna) {
  return luna % LUNA === 0 ? String(luna / LUNA) : (luna / LUNA).toFixed(5);
}

export function toNim(luna) {
  return luna / LUNA;
}

/** "1,234.5" in the given language. Whole NIM by default once amounts are large. */
export function fmtNim(luna, lang = 'en', maxDec) {
  const nim = toNim(luna || 0);
  const dec = maxDec ?? (Math.abs(nim) >= 1000 ? 0 : Math.abs(nim) >= 1 ? 2 : 5);
  return new Intl.NumberFormat(lang, { maximumFractionDigits: dec }).format(nim);
}

export function fmtFiat(luna, price, currency, lang = 'en') {
  if (!price || !currency) return '';
  const value = toNim(luna || 0) * price;
  const dec = value >= 100 ? 0 : value >= 1 ? 2 : 4;
  try {
    return new Intl.NumberFormat(lang, { style: 'currency', currency, maximumFractionDigits: dec, minimumFractionDigits: 0 }).format(value);
  } catch {
    return '';
  }
}

const ALPHABET = /^[0-9A-HJ-NP-VXY]{32}$/;

function ibanRemainder(str) {
  const digits = [...str].map((c) => {
    const code = c.charCodeAt(0);
    return code >= 48 && code <= 57 ? c : String(code - 55);
  }).join('');
  let rem = 0;
  for (let i = 0; i < digits.length; i += 6) {
    rem = Number(String(rem) + digits.slice(i, i + 6)) % 97;
  }
  return rem;
}

/** Canonical "NQxx XXXX ..." form, or null if the string isn't a valid address. */
export function normalizeAddress(input) {
  if (typeof input !== 'string' || input.length > 64) return null;
  const s = input.replace(/\s/g, '').toUpperCase();
  if (s.length !== 36 || !s.startsWith('NQ') || !/^\d{2}$/.test(s.slice(2, 4))) return null;
  if (!ALPHABET.test(s.slice(4))) return null;
  if (ibanRemainder(s.slice(4) + s.slice(0, 4)) !== 1) return null;
  return s.replace(/(.{4})/g, '$1 ').trim();
}

export function shortAddress(address) {
  if (!address) return '';
  const s = address.replace(/\s/g, '');
  return `${s.slice(0, 4)} ${s.slice(4, 8)} … ${s.slice(-4)}`;
}

export function utf8Bytes(str) {
  return new TextEncoder().encode(str).length;
}

/** Cut a string to at most max UTF-8 bytes without splitting a character. */
export function cutBytes(str, max) {
  let out = '';
  let used = 0;
  for (const ch of str) {
    const n = utf8Bytes(ch);
    if (used + n > max) break;
    out += ch;
    used += n;
  }
  return out;
}

export function hexToText(hex) {
  if (typeof hex !== 'string' || hex.length % 2 || !/^[0-9a-fA-F]*$/.test(hex)) return '';
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Short random id for a goal: 6 lowercase letters and digits. */
export function newId() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}
