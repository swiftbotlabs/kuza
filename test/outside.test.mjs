// Fixes after outside testing (7 Nov 2026): every item below was reproduced first, and each test fails on the code
// from before the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../docs/js/goals.js';
import * as J from '../docs/js/jar.js';
import * as P from '../docs/js/spend.js';
import * as I from '../docs/js/invite.js';
import * as N from '../docs/js/nudge.js';
import { toLuna, amountProblem } from '../docs/js/nim.js';
import { dictionaries } from '../docs/js/i18n.js';
import { ln, SPEC_COFFEE, SPEC_TS } from './fixtures/lightning.mjs';

const NIM = 100000;
const WEEK = 7 * 864e5;
const NOW = Date.UTC(2026, 10, 7, 12);
const OWNER = 'NQ32 9CGX GGYH 2DNL D7AL AQGM FHU8 SJ5U 8DKM';
const ok = (kind, luna, at, more = {}) => ({ kind, luna, at, status: 'ok', ...more });
const goal = (entries = [], extra = {}) => ({ ...G.newGoal({ id: 'schabc', name: 'School fees', target: 1000 * NIM, weekly: 250 * NIM, now: NOW }), entries, ...extra });
const hex = (s) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');

test('A1: a payment is booked against a goal only up to what it holds in the wallet', () => {
  const staked = goal([ok('stake', 1000 * NIM, NOW)]);
  assert.equal(G.spendPart(staked, 4200 * NIM), 0); // all of it is in the stake: nothing of this goal was spent
  const mixed = goal([ok('stake', 900 * NIM, NOW), ok('gift', 100 * NIM, NOW)]);
  assert.equal(G.spendPart(mixed, 4200 * NIM), 100 * NIM);
  assert.equal(G.spendPart(mixed, 40 * NIM), 40 * NIM);
  assert.equal(G.spendPart(mixed, -5), 0);
  // the history keeps the whole payment; sanitizeState keeps it too
  mixed.entries.push(ok('spend', G.spendPart(mixed, 4200 * NIM), NOW + 1, { paid: 4200 * NIM, sats: 250000 }));
  assert.deepEqual(G.parts(mixed), { stake: 900 * NIM, wallet: 0, gifts: 100 * NIM });
  const back = G.sanitizeState({ v: 1, goals: [mixed] }).goals[0].entries.at(-1);
  assert.equal(back.paid, 4200 * NIM);
  assert.equal(back.luna, 100 * NIM);
});

test('A2: an expired invoice is refused (BOLT11 time + x, 1 hour when there is no x)', () => {
  assert.deepEqual(P.bolt11Times(SPEC_COFFEE), { ts: SPEC_TS, expiry: 60 });
  assert.equal(P.checkInvoice(SPEC_COFFEE).reason, 'expired');
  assert.equal(P.checkInvoice(SPEC_COFFEE, 'mainnet', (SPEC_TS + 59) * 1000).ok, true);
  assert.equal(P.checkInvoice(SPEC_COFFEE, 'mainnet', (SPEC_TS + 61) * 1000).reason, 'expired');
  const now = Math.floor(Date.now() / 1000);
  assert.equal(P.checkInvoice(ln('lnbc10u')).ok, true);
  assert.equal(P.checkInvoice(ln('lnbc10u', '', { ts: now - 3590 })).ok, true); // no x: one hour
  assert.equal(P.checkInvoice(ln('lnbc10u', '', { ts: now - 3700 })).reason, 'expired');
  assert.equal(P.checkInvoice(ln('lnbc10u', '', { ts: now - 3700, expiry: 86400 })).ok, true);
  assert.equal(P.checkInvoice(ln('lnbc10u', '', { ts: now - 700, expiry: 600 })).reason, 'expired');
  assert.equal(P.bolt11Times(ln('lnbc10u', '', { expiry: 600 })).expiry, 600);
  // the other reasons still come first: a damaged expired invoice is "damaged"
  assert.equal(P.checkInvoice(`${SPEC_COFFEE.slice(0, -1)}q`).reason, 'damaged');
  for (const d of Object.values(dictionaries)) assert.ok(d['spend.err.expired']);
});

// 'Mama B.Day' is not here: .day is a real top-level domain, so it is refused. A dot right after the name ('J.Smith.')
// is refused too, as it could continue an address.
const NAMES = ['B.Sc fees', 'M.Sc tuition', 'B.Com fees', 'B.Ed fees', 'St.Mary school', 'Dr.Visit', 'Gift for J.Smith', 'Fix roof @home',
  'Mt.Kenya trip', 'Lunch @work', 'Mr.Nimiq', 'Dr.Wallet'];
const ATTACKS = ['X.Com/help', 'T.Me/NimiqHelp', 'T.Me @nimiqhelp', 'Claim at Evil.Com', 'Dr.Gift', 'X.Io', 'A.Co', 'J.Smith.com', 'St.Mary.io', 'B.Sc@evil',
  'EvilB.Com', '-B.Com', 'a_B.Com', '1B.Com', 'B.Sc evil.com', 'x.com', 't.me/x', 'Visit Kuza.App', 'NIMIQ.Gift', 'Ｔ．Ｍｅ/x', 'B.Com:8080', 'DM @nimiq_support',
  '@homeoffice_x', 'DM @Nimiq', 'Mr.Gift card', 'St.Link', 'B.Sc/claim', 'Dr.Visit.Com', 'J.Smith.Com', 'B​.Sc.evil',
  // From the security read of the first version of this fix: every one of these passed it, all must be refused.
  '500 NIM bonus: Dr.Sbs', 'Verify wallet at N.Help', 'Refund via Mr.Cfd', 'X.Com', 'X.De', 'K.Ke', 'X.Us', 'Dr.Bz', 'Dr.Support', 'St.Claims',
  'X.Gifts', 'Dr.Loans', 'Mr.Finance', 'X.Exchange', 'Mr.Bond', 'Mr.Zip', 'Dr.Mov', 'Mr.Pro', 'Ms.Fyi', 'X.Zone', 'Dr.Ink', 'Dr.Lol',
  'X.Com?r=1', 'X.Com#a', 'X.Com\\evil', 'X.Com.', '( X.Com )', 'X．Com', 'X​.Com', 'X.C​om', 'Х.Онлайн', 'Д.Сайт', 'Х.Ком', 'Α.Ελ',
  'J.Smith J.Wtf', 'join @market', 'DM @clinic', '@hospital', '@HOME', '@home-x', 'Claim at Dr.Sbs', 'J.Co', 'St.Ly', 'M.Me', 'T.Me', 'Dr.Tk',
  'X.Online', 'X.Cash', 'X.Com,ok', 'Dr.Sbs:80', 'Pay Dr.Rest', 'Mr.Bean.Wtf',
  // Look-alike letters: a Cyrillic S in "Sbs" (mixed scripts), and all-Cyrillic tokens that read as B.Sc / Dr.Sbs.
  'Dr.Ѕbs', 'Mr.Ѕupport', 'В.Ѕс', 'Д.Ѕвѕ',
  // An Armenian o (not in the look-alike table) in X.Com: only the one-script rule catches it.
  'X.C\u0585m', 'Dr.Sb\u0585',
  // Second security read (8 Nov): endings written as a domain would be matched (ß as ss, accents dropped), six endings the
  // embedded list lacked, and degrees whose ending is a real, registrable one.
  'Mr.Preß', 'Dr.Glaß', 'X.Busineß', 'Dr.Fitneß', 'Dr.Swiß', 'Dr.Hotel', 'Mt.Helsinki', 'X.Juniper', 'Mr.Goo', 'Dr.Onion',
  'X.Wolterskluwer', 'M.Com', 'B.Tech', 'M.Tech', 'M.Com fees', 'B.Tech fees', 'Dr.Cafe\u0301', 'Mr.Caf\u00e9'];

test('A3: initials and short titles are names, not links; the shapes an address takes are still refused', () => {
  for (const name of NAMES) {
    assert.ok(!J.linkish(name), `false positive ${JSON.stringify(name)}`);
    assert.equal(J.cleanName(name), name);
    const back = J.decodeInvite(J.encodeInvite({ id: 'schabc', name, target: 1000 * NIM, date: null, owner: OWNER, net: 'mainnet' }));
    assert.equal(back?.name, name, name);
  }
  for (const a of ATTACKS) {
    assert.ok(J.linkish(a), `let through ${JSON.stringify(a)}`);
    assert.equal(J.cleanName(a), '', a);
    assert.equal(J.parseMemo(hex(J.buildMemo('schabc', a))).note, '', a);
  }
  assert.ok(ATTACKS.length >= 85, String(ATTACKS.length));
});

test('A3 positive control: the check is the full list of real top-level domains, not a short list of known bad ones', () => {
  assert.ok(J.TLDS.size > 1400 && J.TLDS.has('com') && J.TLDS.has('sbs') && J.TLDS.has('рф') && J.TLDS.has('онлайн'));
  // endings never on any blocklist, but real domains: refused; the same shape with a word that is no domain: a name
  for (const a of ['Mr.Xyz', 'Dr.Sbs', 'Ms.Lgbt', 'X.Fyi', 'Dr.Ninja', 'St.Kitchen']) assert.ok(J.linkish(a), a);
  for (const n of ['Mr.Xyzzy', 'Dr.Sbsx', 'St.Kitchens', 'Dr.Smith']) assert.ok(!J.linkish(n), n);
  // "Preß" is refused because it is read as "press", not because "preß" is on the list; a folded word that is no
  // ending still passes.
  assert.ok(!J.TLDS.has('preß') && !J.TLDS.has('glaß') && J.TLDS.has('press') && J.TLDS.has('glass'));
  assert.ok(J.linkish('Mr.Preß') && J.linkish('Dr.Glaß') && J.linkish('Dr.Caf\u00e9'));
  for (const n of ['Mr.Weiß', 'Dr.Strauß', 'Mt.Élgon']) assert.ok(!J.linkish(n), n);
  // Degrees: only B.Sc, M.Sc and B.Com are let through by name.
  for (const d of ['B.Sc', 'M.Sc', 'B.Com']) assert.ok(!J.linkish(d), d);
});

test('A3: a friend\'s note with a degree in it reaches the owner; a link-like note is stopped before it is sent', () => {
  assert.deepEqual(J.parseMemo(hex(J.buildMemo('abc234', 'for B.Sc fees, from auntie'))), { id: 'abc234', note: 'for B.Sc fees, from auntie' });
  assert.equal(J.noteRefused('for B.Sc fees, from auntie'), false);
  assert.equal(J.noteRefused(''), false);
  for (const a of ['see t.me/x', 'evil.com', 'DM @nimiq_help', 'nimiq-gift．com']) assert.equal(J.noteRefused(a), true, a);
  // checked on the note as it is sent (cut to the memo's 64 bytes): what passes the check is what the owner sees
  const long = `${'x'.repeat(48)} evil.com`;
  assert.equal(J.noteRefused(long), J.parseMemo(hex(J.buildMemo('abc234', long))).note === '');
});

test('A4: thousands separators: unambiguous ones are read, "1,000" gets the right message', () => {
  assert.equal(toLuna('2,000.50'), 2000.5 * NIM);
  assert.equal(toLuna('10.000,50'), 10000.5 * NIM);
  assert.equal(toLuna('1,000,000'), 1e6 * NIM);
  assert.equal(toLuna('1.000.000'), 1e6 * NIM);
  assert.equal(toLuna('1 000'), 1000 * NIM);
  assert.equal(toLuna('12,5'), 12.5 * NIM);
  for (const x of ['1,000', '10,000', '12,345', '1.000']) {
    assert.equal(toLuna(x), null, x); // a thousand or one: still not guessed
    assert.equal(amountProblem(x), 'separators', x);
  }
  assert.equal(amountProblem('1,00,000'), 'separators');
  assert.equal(amountProblem('abc'), 'invalid');
  assert.equal(amountProblem('1000'), null);
  for (const d of Object.values(dictionaries)) assert.ok(d['form.errSeparators'] && !/at least 1/i.test(d['form.errSeparators']));
});

test('A5: the first saving of a goal with a plan is the plan\'s amount, not the whole target', () => {
  const g = goal();
  const planned = G.nextSave(g, NOW + 1).amount;
  assert.equal(planned, 250 * NIM);
  const s = { spendable: 25000 * NIM, noted: 0, staker: null, left: G.progress(g).left };
  assert.equal(N.firstSuggestion({ ...s, planned }), 250 * NIM);
  assert.equal(N.firstSuggestion(s), 1000 * NIM); // no plan: what the wallet can spare, up to the target
  assert.equal(N.firstSuggestion({ ...s, spendable: 130 * NIM, planned }), 129 * NIM); // short wallet: less than the plan
});

test('A6: the counter says wallets connected, not that they use Kuza', () => {
  for (const [code, d] of Object.entries(dictionaries)) {
    for (const k of ['foot.wallets_one', 'foot.wallets_other']) {
      assert.ok(!/use Kuza|uses Kuza|usan? Kuza|utilisen?t? Kuza|inatumia|zinatumia/.test(d[k]), `${code} ${k}: ${d[k]}`);
      assert.ok(d[k].includes('{n}'));
    }
  }
  assert.equal(dictionaries.en['foot.wallets_other'], '{n} wallets have connected');
  assert.ok(dictionaries.en['entry.proofDemo']);
});

test('B1: NIM taken out of the stake stays with the goal, in the wallet, until spent; no step goes below 0', () => {
  const g = goal([ok('stake', 1000 * NIM, NOW)]);
  const w = G.withdrawEntry(g, 1000 * NIM, 0, NOW + 1);
  assert.deepEqual(w, { kind: 'withdraw', luna: 1000 * NIM, at: NOW + 1, status: 'ok', toWallet: true });
  g.entries.push(w);
  assert.deepEqual(G.parts(g), { stake: 0, wallet: 1000 * NIM, gifts: 0 });
  assert.equal(G.progress(g).ratio, 1);
  g.entries.push(ok('spend', 1000 * NIM, NOW + 2));
  assert.deepEqual(G.parts(g), { stake: 0, wallet: 0, gifts: 0 });
  // an over-large spend can't leave a debt that swallows a later gift
  const h = goal([ok('spend', 1000 * NIM, NOW), ok('gift', 50 * NIM, NOW + 1)]);
  assert.equal(G.parts(h).wallet, 50 * NIM);
  const m = goal([ok('move', 500 * NIM, NOW), ok('stake', 200 * NIM, NOW + 1)]);
  assert.equal(G.parts(m).stake, 200 * NIM);
  // a withdrawal booked before this fix (no toWallet) keeps its old meaning: the NIM left the goal
  const old = goal([ok('stake', 160 * NIM, NOW), ok('withdraw', 60 * NIM, NOW + 1)]);
  assert.deepEqual(G.parts(old), { stake: 100 * NIM, wallet: 0, gifts: 0 });
  // never more than the goal had in the stake; nothing at all when none of it was the goal's
  assert.equal(G.withdrawEntry(goal([ok('stake', 300 * NIM, NOW)]), 500 * NIM, 0, NOW).luna, 300 * NIM);
  assert.equal(G.withdrawEntry(goal(), 500 * NIM, 0, NOW), null);
  // the stored state keeps the new fields
  const st = G.sanitizeState({ v: 1, goals: [g] });
  assert.equal(st.goals[0].entries[1].toWallet, true);
  assert.equal(G.parts(st.goals[0]).wallet, 0);
});

test('B2: "done this week" counts what the goal gained, net: a spend undoes it, stake moved in counts', () => {
  const g = goal([ok('stake', 250 * NIM, NOW + 1)]);
  assert.equal(G.nextSave(g, NOW + 10).done, true);
  g.entries.push(G.withdrawEntry(g, 250 * NIM, 0, NOW + 2));
  assert.equal(G.nextSave(g, NOW + 10).done, true); // still the goal's, in the wallet
  g.entries.push(ok('spend', 250 * NIM, NOW + 3));
  assert.equal(G.nextSave(g, NOW + 10).done, false);
  assert.equal(G.nextSave(g, NOW + 10).amount, 250 * NIM); // the plan amount, not more
  assert.equal(G.streak(g, NOW + 10), 0);
  assert.equal(G.weekStrip(g, NOW + 10, 1)[0].amount, 0);
  // an older withdrawal (before toWallet) left the goal, so it can't count as this week's saving either
  const old = goal([ok('stake', 250 * NIM, NOW + 1), ok('withdraw', 250 * NIM, NOW + 2)]);
  assert.equal(G.nextSave(old, NOW + 10).done, false);
  // a goal funded by moving a reached goal's stake over has its week done
  const next = goal([ok('assign', 1000 * NIM, NOW + 1, { ref: 'Phone' })]);
  assert.equal(G.nextSave(next, NOW + 10).done, true);
  assert.equal(G.streak(next, NOW + 10), 1);
  // and the goal it came from doesn't count that week any more
  const from = goal([ok('stake', 250 * NIM, NOW + 1), ok('move', 250 * NIM, NOW + 2, { ref: 'Next' })]);
  assert.equal(G.streak(from, NOW + 10), 0);
  // moving the goal's own wallet NIM into the stake is still not new money
  const own = goal([ok('aside', 60 * NIM, NOW + 1), ok('stake', 60 * NIM, NOW + 2, { fromWallet: 60 * NIM })]);
  assert.equal(G.weekStrip(own, NOW + 3, 1)[0].amount, 60 * NIM);
  // a week before stays met when a later week spends: history is history
  const later = goal([ok('stake', 250 * NIM, NOW + 1), ok('spend', 100 * NIM, NOW + WEEK + 1)]);
  assert.equal(G.weekStrip(later, NOW + WEEK + 2, 2)[0].met, true);
});

test('B3: the goal\'s Earned keeps the rewards that came out with its NIM, and they are not shared out again', () => {
  const a = goal([ok('stake', 1000 * NIM, NOW)]);
  const earned = 25 * NIM;
  const share = G.earnedShare(a, [a], earned, 1000 * NIM);
  assert.equal(share, 25 * NIM);
  // everything comes out: 1,025 NIM, of which 25 are rewards
  a.entries.push(G.withdrawEntry(a, 1025 * NIM, share, NOW + 1));
  const p = G.progress(a, G.earnedShare(a, [a], earned, 0));
  assert.equal(p.earnedAll, 25 * NIM); // what the goal's tile shows: the same 25 the rewards sheet totals
  assert.equal(p.wallet, 1025 * NIM);
  assert.equal(p.saved, 1025 * NIM);
  // a new goal staked afterwards doesn't inherit the 25 that already left
  const b = goal([ok('stake', 1000 * NIM, NOW + 2)], { id: 'nxtabc' });
  assert.equal(G.earnedShare(b, [a, b], earned, 1000 * NIM), 0);
  assert.equal(G.earnedShare(b, [a, b], earned + 5 * NIM, 1000 * NIM), 5 * NIM);
  // rewards credited are never more than what came out beyond the goal's own stake
  const c = goal([ok('stake', 1000 * NIM, NOW)]);
  assert.equal(G.withdrawEntry(c, 1010 * NIM, 25 * NIM, NOW).earned, 10 * NIM);
  assert.equal(G.withdrawEntry(c, 1000 * NIM, 25 * NIM, NOW).earned, undefined);
});

test('B4 (not reproduced, guard): monthly plans made on the 29th-31st: the period of a moment and its start agree', () => {
  for (const day of [28, 29, 30, 31]) {
    const g = { ...goal(), every: 'month', weekly: 100 * NIM, createdAt: Date.UTC(2027, 0, day, 10) };
    for (let t = g.createdAt; t < g.createdAt + 430 * 864e5; t += 864e5 / 4) {
      const i = G.planPeriod(g, t);
      assert.ok(G.periodStart(g, i) <= t && t < G.periodStart(g, i + 1), `${day}: ${new Date(t).toISOString()} in period ${i}`);
    }
    // a short month is clamped to its last day, never rolled into the next month
    assert.equal(new Date(G.periodStart(g, 1)).toISOString().slice(0, 10), `2027-02-${day > 28 ? 28 : day}`);
  }
});

test('B5: a goal made in the demo invites into the demo', () => {
  const g = { id: 'schabc', name: 'School fees', target: 1000 * NIM, date: null };
  const demo = I.inviteLink(g, OWNER, 'mainnet', true);
  assert.ok(demo.startsWith('https://kuza.swiftbotlab.workers.dev/?demo=1&j=m'));
  const u = new URL(demo);
  assert.equal(u.searchParams.get('demo'), '1');
  assert.equal(J.readInvite(u.searchParams).jar.name, 'School fees');
  assert.ok(!I.inviteLink(g, OWNER, 'mainnet').includes('demo'));
});
