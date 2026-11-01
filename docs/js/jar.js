// Group jar: a link that describes a goal, and the memo that ties a gift to it.
// Nothing here touches a server. The link carries the goal, the chain carries the gifts.

import { LUNA, normalizeAddress, utf8Bytes, cutBytes, hexToText } from './nim.js';
import { STAKING_CONTRACT } from './staking.js';

export const MEMO_PREFIX = 'KZ1';
export const MEMO_MAX = 64;
const ID_RE = /^[a-z2-9]{6}$/;
const NOBODY = new Set([STAKING_CONTRACT, 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000', 'NQ81 C01N BASE 0000 0000 0000 0000 0000 0000']);

export function cleanText(input, maxChars) {
  if (typeof input !== 'string') return '';
  // Control, format and bidi characters and blank look-alikes have no place in a name or a public note.
  const noCtl = input.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0]/gu, ' ');
  return [...noCtl.replace(/\s+/g, ' ').trim()].slice(0, maxChars).join('');
}

function b64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text) {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeJar({ id, name, target, date, owner, net }) {
  return b64urlEncode(JSON.stringify({ v: 1, i: id, n: name, t: target, d: date, a: owner.replace(/\s/g, ''), e: net === 'testnet' ? 't' : 'm' }));
}

/** Parse the ?jar= value. Everything in it is untrusted; returns null unless all of it checks out. */
export function decodeJar(param) {
  if (typeof param !== 'string' || !param || param.length > 512 || !/^[A-Za-z0-9_-]+$/.test(param)) return null;
  let o;
  try {
    o = JSON.parse(b64urlDecode(param));
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || o.v !== 1) return null;
  const owner = normalizeAddress(o.a);
  const name = cleanText(o.n, 40);
  if (!owner || NOBODY.has(owner) || !name || typeof o.i !== 'string' || !ID_RE.test(o.i)) return null;
  if (!Number.isSafeInteger(o.t) || o.t <= 0 || o.t > 21e14) return null;
  if (o.d !== null && o.d !== undefined && (typeof o.d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.d) || Number.isNaN(Date.parse(`${o.d}T12:00:00Z`)))) return null;
  if (o.e !== 'm' && o.e !== 't') return null;
  return { id: o.i, name, target: o.t, date: o.d || null, owner, net: o.e === 't' ? 'testnet' : 'mainnet' };
}

/** Public text for the transaction: KZ1|goalid|note, at most 64 bytes. */
export function buildMemo(id, note) {
  const head = `${MEMO_PREFIX}|${id}|`;
  return head + cutBytes(cleanText(note, 60).replace(/\|/g, '/'), MEMO_MAX - utf8Bytes(head));
}

export function parseMemo(hex) {
  const text = hexToText(hex);
  const m = /^KZ1\|([a-z2-9]{6})\|?(.*)$/s.exec(text);
  return m ? { id: m[1], note: cleanText(m[2], 60) } : null;
}

/**
 * Gifts in a list of transactions, as returned by getTransactionsByAddress.
 * Only executed transfers TO the owner, from someone else, of at least 1 NIM, with a valid memo count, each once.
 * The goal id is public in the invite link, so dust must not be able to fill up a goal's history.
 */
export function giftsFromHistory(txs, owner, goalId) {
  const seen = new Set();
  const out = [];
  for (const tx of txs || []) {
    if (!tx || tx.executionResult === false || tx.to !== owner || tx.from === owner || seen.has(tx.hash)) continue;
    const memo = parseMemo(tx.recipientData || '');
    if (!memo || (goalId && memo.id !== goalId)) continue;
    if (!Number.isSafeInteger(tx.value) || tx.value < LUNA) continue;
    seen.add(tx.hash);
    out.push({ hash: tx.hash, goal: memo.id, note: memo.note, luna: tx.value, from: tx.from, at: Math.abs(tx.timestamp) <= 8.64e15 ? tx.timestamp : 0, block: tx.blockNumber });
  }
  return out.sort((a, b) => b.at - a.at);
}
