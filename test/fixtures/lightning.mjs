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
// The data part of a BOLT11 invoice (timestamp, tagged fields, signature) without its checksum; the shape the tests use.
export const DATA = 'pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqf';
/** A checksummed invoice, e.g. ln('lnbc2500u'), ln('lnbc10u', variant) for a different one with the same amount. */
export const ln = (hrp, variant = '') => withChecksum(hrp, DATA + variant);
