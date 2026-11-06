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
  // Invisible characters go entirely (a joiner hidden before a dot must not survive as a gap); breaks become spaces.
  const noCtl = input.replace(/\p{Default_Ignorable_Code_Point}/gu, '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u1160\u2800\u3164\uFFA0]/gu, ' ');
  return [...noCtl.replace(/\s+/g, ' ').trim()].slice(0, maxChars).join('');
}

const DOTS = /[。．｡﹒․܁܂]/g;
const LINKISH = /(:\/\/|www\.|[\p{L}\p{N}\p{Extended_Pictographic}_-]\.\p{L}{2,}|\d{1,3}(\.\d{1,3}){3}|@[\p{L}\p{N}_]{3,}|\bNQ\s?\d{2}(\s?[0-9A-Z]{4}){2})/iu;

/**
 * Does the text read like a way to reach someone: a web address (any script, look-alike dots, invisible marks before
 * the dot, a bare IP), an @handle or a Nimiq address? A goal name and a gift note are shown to strangers (the invite
 * page, a shared message), so neither may carry one someone else planted. The comparison runs on a folded copy
 * (NFKC, no invisible or combining marks, look-alike dots made plain); the text itself is never changed by it.
 */
export function linkish(text) {
  if (typeof text !== 'string') return false;
  const s = text.normalize('NFKC').replace(/[\p{Default_Ignorable_Code_Point}\p{M}]/gu, '').replace(DOTS, '.');
  return LINKISH.test(s);
}

/** A goal name as it may be shown: cleaned, with at least one letter or digit, and nothing that reads like a link. */
export function cleanName(input) {
  const name = cleanText(input, 40);
  return name && /[\p{L}\p{N}]/u.test(name) && !linkish(name) ? name : '';
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
  const name = cleanName(o.n);
  if (!owner || NOBODY.has(owner) || !name || typeof o.i !== 'string' || !ID_RE.test(o.i)) return null;
  if (!Number.isSafeInteger(o.t) || o.t <= 0 || o.t > 21e14) return null;
  if (o.d !== null && o.d !== undefined && (typeof o.d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.d) || Number.isNaN(Date.parse(`${o.d}T12:00:00Z`)))) return null;
  if (o.e !== 'm' && o.e !== 't') return null;
  return { id: o.i, name, target: o.t, date: o.d || null, owner, net: o.e === 't' ? 'testnet' : 'mainnet' };
}

/**
 * The short form of the same link, used for every new invite: ?j=<net><address>.<id>.<target>.<date>.<name>
 *   net m or t, the address without spaces (its checksum still checks), the goal id, the target in Luna as base 36,
 *   the date as YYYYMMDD or empty, the name as base64url UTF-8. About 120 characters in all instead of 200.
 */
export function encodeInvite({ id, name, target, date, owner, net }) {
  const day = date ? date.replace(/-/g, '') : '';
  return `${net === 'testnet' ? 't' : 'm'}${owner.replace(/\s/g, '')}.${id}.${target.toString(36)}.${day}.${b64urlEncode(cleanText(name, 40))}`;
}

const INVITE_RE = /^([mt])(NQ[0-9]{2}[0-9A-Z]{32})\.([a-z2-9]{6})\.([0-9a-z]{1,11})\.(\d{8})?\.([A-Za-z0-9_-]{1,216})$/;

/** Parse the ?j= value. Untrusted like the long form: null unless every part checks out. */
export function decodeInvite(param) {
  if (typeof param !== 'string' || !param || param.length > 300) return null;
  const m = INVITE_RE.exec(param);
  if (!m) return null;
  const owner = normalizeAddress(m[2]);
  if (!owner || NOBODY.has(owner)) return null;
  const target = parseInt(m[4], 36);
  if (!Number.isSafeInteger(target) || target <= 0 || target > 21e14) return null;
  let date = null;
  if (m[5]) {
    date = `${m[5].slice(0, 4)}-${m[5].slice(4, 6)}-${m[5].slice(6)}`;
    const back = new Date(`${date}T12:00:00Z`);
    if (Number.isNaN(back.getTime()) || back.toISOString().slice(0, 10) !== date) return null;
  }
  let name;
  try {
    name = cleanName(b64urlDecode(m[6]));
  } catch {
    return null;
  }
  if (!name) return null;
  return { id: m[3], name, target, date, owner, net: m[1] === 't' ? 'testnet' : 'mainnet' };
}

/** The goal a page address points at: the short ?j= form first, then the older ?jar= form. */
export function readInvite(params) {
  const short = params.get('j');
  if (short !== null) return { jar: decodeInvite(short), given: true };
  const long = params.get('jar');
  if (long !== null) return { jar: decodeJar(long), given: true };
  return { jar: null, given: false };
}

/** Public text for the transaction: KZ1|goalid|note, at most 64 bytes. */
export function buildMemo(id, note) {
  const head = `${MEMO_PREFIX}|${id}|`;
  return head + cutBytes(cleanText(note, 60).replace(/\|/g, '/'), MEMO_MAX - utf8Bytes(head));
}

export function parseMemo(hex) {
  const text = hexToText(hex);
  const m = /^KZ1\|([a-z2-9]{6})\|?(.*)$/s.exec(text);
  if (!m) return null;
  const note = cleanText(m[2], 60);
  return { id: m[1], note: linkish(note) ? '' : note }; // anyone can pay 1 NIM with a note: no links shown
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
