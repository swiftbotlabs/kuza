// Test invoices with a correct bech32 checksum, built here independently of docs/js/spend.js (and checked against the
// BIP-173 test vectors in v3.test.mjs), so the tests don't trust the code they test.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function mod(values) {
  let c = 1;
  for (const v of values) {
    const b = c >>> 25;
    c = ((c & 0x1ffffff) << 5) ^ v;
    GEN.forEach((g, i) => { if ((b >>> i) & 1) c ^= g; });
  }
  return c >>> 0;
}
/** hrp + '1' + data + the six checksum characters. */
export function withChecksum(hrp, data) {
  const h = [...hrp].map((x) => x.charCodeAt(0));
  const d = [...data].map((x) => CHARSET.indexOf(x));
  const m = mod([...h.map((x) => x >> 5), 0, ...h.map((x) => x & 31), ...d, 0, 0, 0, 0, 0, 0]) ^ 1;
  return `${hrp}1${data}${[0, 1, 2, 3, 4, 5].map((i) => CHARSET[(m >>> (5 * (5 - i))) & 31]).join('')}`;
}
// A BOLT11 data part: 35-bit timestamp, tagged fields (payment secret s, payment hash p, optional expiry x), then a
// 104-word signature (made up here: Kuza never checks it, the wallet does), then the checksum.
const word = (n) => CHARSET[n];
const timeWords = (sec) => [6, 5, 4, 3, 2, 1, 0].map((i) => word(Math.floor(sec / 32 ** i) % 32)).join('');
const field = (type, data) => `${type}${word(data.length >> 5)}${word(data.length & 31)}${data}`;
const TAGS = field('s', 'zyg3'.repeat(13)) + field('p', `${'qqqsyqcyq5rqwzqf'.repeat(3)}qqqs`);
const expiryWords = (sec) => { let out = ''; for (let n = sec; n > 0; n = Math.floor(n / 32)) out = word(n % 32) + out; return out || 'q'; };
/** The 2017 timestamp of the BOLT11 spec's own examples, for expired invoices. */
export const SPEC_TS = 1496314658;
/**
 * A checksummed invoice made now (or at `ts`), e.g. ln('lnbc2500u'); ln('lnbc10u', variant) for a different one with the
 * same amount; ln('lnbc10u', '', { ts, expiry }) for a chosen time and x field (seconds).
 */
export const ln = (hrp, variant = '', { ts = Math.floor(Date.now() / 1000), expiry = null } = {}) =>
  withChecksum(hrp, timeWords(ts) + TAGS + (expiry === null ? '' : field('x', expiryWords(expiry))) + `${variant}${'z'.repeat(104)}`.slice(0, 104));
/** The same text with its last `n` characters each changed, so the checksum can never still match by luck. */
export const damaged = (s, n = 1) => s.slice(0, -n) + [...s.slice(-n)].map((c) => (c === 'q' ? 'p' : 'q')).join('');
// The BOLT11 spec's "1 cup coffee" example: made 1 Jun 2017 10:57:38 UTC, x = 60 s, so long expired. Real signature.
export const SPEC_COFFEE = 'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
