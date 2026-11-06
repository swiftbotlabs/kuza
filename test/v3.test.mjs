// Invite links, deep links, monthly plans, milestones, rewards seen arriving, and the Lightning invoice check.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as J from '../docs/js/jar.js';
import * as I from '../docs/js/invite.js';
import * as G from '../docs/js/goals.js';
import * as R from '../docs/js/rewards.js';
import * as P from '../docs/js/spend.js';
import * as W from '../docs/js/wallet.js';

const NIM = 100000;
const DAY = 864e5;
const WEEK = 7 * DAY;
const OWNER = 'NQ32 9CGX GGYH 2DNL D7AL AQGM FHU8 SJ5U 8DKM';
const GOAL = { id: '64ru59', name: 'Emergency fund', target: 50000 * NIM, date: '2027-03-01', owner: OWNER, net: 'mainnet' };

test('short invite: round trip, about 80 characters, every field checked', () => {
  const v = J.encodeInvite(GOAL);
  assert.ok(v.length <= 90, `length ${v.length}`);
  assert.deepEqual(J.decodeInvite(v), GOAL);
  const t = { ...GOAL, net: 'testnet', date: null, name: 'Ada ya shule · 学费 🎓' };
  assert.deepEqual(J.decodeInvite(J.encodeInvite(t)), t);
  const long = { ...GOAL, name: '学'.repeat(40) };
  assert.deepEqual(J.decodeInvite(J.encodeInvite(long)), long);
  const bad = [
    '', null, 42, 'x'.repeat(301),
    v.replace('8DKM', '8DKN'), // checksum
    v.replace('64ru59', '64RU59'), v.replace('64ru59', '64ru5'), // id alphabet and length
    v.replace('.20270301.', '.20270231.'), v.replace('.20270301.', '.2027031.'), // impossible date, short date
    v.replace(/^m/, 'x'), v.replace(/\.[^.]+\.20270301/, '.zzzzzzzzzzzz.20270301'), // network, target too long
    v.replace(/\.[^.]+\.20270301/, `.${(21e14 + 1).toString(36)}.20270301`), v.replace(/\.[^.]+\.20270301/, '.0.20270301'),
    v.replace(/\.[A-Za-z0-9_-]+$/, '.'), v.replace(/\.[A-Za-z0-9_-]+$/, '.ICAg'), // empty name, blank name
    v.replace(/\.[A-Za-z0-9_-]+$/, '.%3Cb%3E'), `${v}.extra`, v.replace(/\./g, '-'),
    J.encodeInvite({ ...GOAL, owner: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000' }),
    J.encodeInvite({ ...GOAL, owner: 'NQ77 0000 0000 0000 0000 0000 0000 0000 0001' }),
  ];
  for (const b of bad) assert.equal(J.decodeInvite(b), null, String(b).slice(0, 80));
  // Markup in a name stays text; control characters go.
  assert.equal(J.decodeInvite(J.encodeInvite({ ...GOAL, name: 'Bike <b>‮\u0000x' })).name, 'Bike <b> x');
});

test('readInvite: the short form first, the old ?jar= links still open', () => {
  const short = new URLSearchParams(`j=${J.encodeInvite(GOAL)}`);
  assert.deepEqual(I.platformOf('') , null);
  assert.deepEqual(J.readInvite(short), { jar: GOAL, given: true });
  const old = new URLSearchParams(`jar=${J.encodeJar(GOAL)}`);
  assert.deepEqual(J.readInvite(old), { jar: GOAL, given: true });
  assert.deepEqual(J.readInvite(new URLSearchParams('j=nonsense')), { jar: null, given: true });
  assert.deepEqual(J.readInvite(new URLSearchParams('demo=1')), { jar: null, given: false });
  const both = new URLSearchParams(`j=${J.encodeInvite(GOAL)}&jar=broken`);
  assert.deepEqual(J.readInvite(both).jar, GOAL);
});

test('invite link and the ways into Nimiq Pay', () => {
  const link = I.inviteLink(GOAL, OWNER, 'mainnet');
  assert.ok(link.startsWith('https://kuza.swiftbotlab.workers.dev/?j=m'));
  assert.ok(link.length <= 130, `link ${link.length}`);
  const deep = I.payDeepLink(link);
  assert.ok(deep.startsWith('nimiqpay://miniapp?url='));
  assert.equal(new URL(deep).searchParams.get('url'), link);
  const intent = I.androidIntent(link);
  assert.match(intent, /^intent:\/\/miniapp\?url=[^#;]+#Intent;scheme=nimiqpay;package=com\.nimiq\.pay;S\.browser_fallback_url=https%3A%2F%2Fplay\.google\.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dcom\.nimiq\.pay;end$/);
  assert.equal(decodeURIComponent(intent.slice('intent://miniapp?url='.length, intent.indexOf('#'))), link);
  assert.equal(I.openInPayLink(link, 'android'), intent);
  assert.equal(I.openInPayLink(link, 'ios'), deep);
  assert.equal(I.openInPayLink(link, null), deep);
  assert.equal(I.platformOf('Mozilla/5.0 (Linux; Android 15; SM-A145F) AppleWebKit/537.36 Chrome/141 Mobile'), 'android');
  assert.equal(I.platformOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)'), 'ios');
  assert.equal(I.platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5), 'ios');
  assert.equal(I.platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0), null);
  assert.equal(I.platformOf('Mozilla/5.0 (X11; Linux x86_64)'), null);
  assert.deepEqual(I.storeFor('android'), [I.PLAY_URL]);
  assert.deepEqual(I.storeFor('ios'), [I.APPSTORE_URL]);
  assert.equal(I.storeFor(null).length, 2);
});

test('monthly plans keep the day of the month, short months included', () => {
  const g = G.newGoal({ id: 'mmmmmm', name: 'M', target: 1200 * NIM, weekly: 100 * NIM, every: 'month', now: Date.UTC(2026, 0, 31, 10) });
  assert.equal(g.every, 'month');
  assert.equal(new Date(G.periodStart(g, 1)).toISOString(), '2026-02-28T10:00:00.000Z');
  assert.equal(new Date(G.periodStart(g, 2)).toISOString(), '2026-03-31T10:00:00.000Z');
  assert.equal(G.planPeriod(g, Date.UTC(2026, 0, 31, 10)), 0);
  assert.equal(G.planPeriod(g, Date.UTC(2026, 1, 28, 9, 59)), 0);
  assert.equal(G.planPeriod(g, Date.UTC(2026, 1, 28, 10)), 1);
  assert.equal(G.planPeriod(g, Date.UTC(2026, 2, 31, 9)), 1);
  assert.equal(G.planPeriod(g, Date.UTC(2027, 0, 31, 10)), 12);
  // A weekly goal reads exactly as before.
  const w = G.newGoal({ id: 'wwwwww', name: 'W', target: 1000 * NIM, weekly: 50 * NIM, now: 0 });
  assert.equal(w.every, 'week');
  assert.equal(G.planPeriod(w, WEEK * 3 + 5), 3);
  assert.equal(G.planWeek(w, WEEK * 3 + 5), 3);
});

test('next save, projection and plan status', () => {
  const start = Date.UTC(2026, 10, 2, 12);
  const g = G.newGoal({ id: 'pppppp', name: 'P', target: 1000 * NIM, weekly: 100 * NIM, now: start });
  // Nothing saved in week 0.
  let n = G.nextSave(g, start + DAY);
  assert.deepEqual(n, { amount: 100 * NIM, by: start + WEEK, done: false });
  assert.equal(G.planStatus(g, 0, start + DAY), null); // too early to judge
  let p = G.projectFinish(g, 1000 * NIM, start + DAY);
  assert.deepEqual(p, { at: start + 10 * WEEK, periods: 10 });
  // 60 saved: 40 still due this week.
  g.entries.push({ kind: 'stake', luna: 60 * NIM, at: start + DAY, status: 'ok' });
  n = G.nextSave(g, start + 2 * DAY);
  assert.equal(n.amount, 40 * NIM);
  // This week met: the next one asks for the full amount, from next week.
  g.entries.push({ kind: 'aside', luna: 40 * NIM, at: start + 2 * DAY, status: 'ok' });
  n = G.nextSave(g, start + 3 * DAY);
  assert.deepEqual(n, { amount: 100 * NIM, from: start + WEEK, by: start + 2 * WEEK, done: true });
  p = G.projectFinish(g, 900 * NIM, start + 3 * DAY);
  assert.deepEqual(p, { at: start + 10 * WEEK, periods: 9 });
  // Two weeks later, nothing more saved: 100 behind the plan for the one week that ended without a saving.
  const st = G.planStatus(g, 100 * NIM, start + 2 * WEEK + DAY);
  assert.deepEqual(st, { expected: 200 * NIM, delta: -100 * NIM, ok: false, by: 'plan' });
  // With a date the straight line to the date decides.
  g.date = '2027-01-11';
  assert.equal(G.planStatus(g, 100 * NIM, start + 2 * WEEK + DAY).by, 'date');
  // Reached or no plan: nothing to project.
  assert.equal(G.projectFinish(g, 0, start), null);
  assert.equal(G.projectFinish({ ...g, weekly: 0 }, 5, start), null);
  assert.equal(G.nextSave({ ...g, weekly: 0 }, start), null);
  // Monthly suggestion.
  assert.deepEqual(G.suggestPlan(1200 * NIM, '2027-11-01', Date.UTC(2026, 10, 1), 'month'), { amount: 100 * NIM, periods: 12 });
  assert.deepEqual(G.suggestPlan(1200 * NIM, '2027-11-02', Date.UTC(2026, 10, 1), 'month'), { amount: Math.ceil(1200 * NIM / 13), periods: 13 });
  assert.deepEqual(G.suggestPlan(1200 * NIM, null, Date.UTC(2026, 10, 1), 'month'), { amount: 0, periods: 0 });
  assert.equal(G.suggestPlan(700 * NIM, '2026-11-14', Date.UTC(2026, 10, 1), 'week').periods, 2); // 13 days and a bit: 2 weeks
});

test('milestones: each mark once, old goals start where they stand', () => {
  const g = G.newGoal({ id: 'kkkkkk', name: 'K', target: 100 * NIM, now: 0 });
  assert.equal(G.newMark(g, 0.1), 0);
  assert.equal(G.newMark(g, 0.3), 25);
  assert.equal(G.newMark(g, 0.8), 75);
  g.marks.push(25, 50, 75);
  assert.equal(G.newMark(g, 0.8), 0);
  assert.equal(G.newMark(g, 1), 100);
  assert.equal(G.newMark({ ...g, marks: undefined }, 1), 0);
  assert.deepEqual(G.passedMarks(0.6), [25, 50]);
  const st = G.sanitizeState({ v: 1, goals: [{ id: 'oldone', name: 'Old', target: 5, entries: [] }, { id: 'newone', name: 'New', target: 5, entries: [], marks: [25, 33, 'x'], every: 'month', reachedAt: 7 }] });
  assert.equal(st.goals[0].marks, undefined);
  assert.equal(st.goals[0].every, 'week');
  assert.deepEqual(st.goals[1].marks, [25]);
  assert.equal(st.goals[1].every, 'month');
  assert.equal(st.goals[1].reachedAt, 7);
});

test('moving a goal on keeps the total in stake the same and labels both sides', () => {
  const a = G.newGoal({ id: 'aaaaaa', name: 'A', target: 100 * NIM, now: 0 });
  const b = G.newGoal({ id: 'bbbbbb', name: 'B', target: 500 * NIM, now: 0 });
  a.entries.push({ kind: 'stake', luna: 120 * NIM, at: 1, status: 'ok' });
  const before = G.totalPrincipal([a, b]);
  a.entries.push({ kind: 'move', luna: 120 * NIM, at: 2, status: 'ok', ref: 'B' });
  b.entries.push({ kind: 'assign', luna: 120 * NIM, at: 2, status: 'ok', ref: 'A' });
  assert.equal(G.parts(a).stake, 0);
  assert.equal(G.parts(b).stake, 120 * NIM);
  assert.equal(G.totalPrincipal([a, b]), before);
  // A spend is history only.
  b.entries.push({ kind: 'spend', luna: 50 * NIM, at: 3, status: 'ok' });
  assert.equal(G.parts(b).stake, 120 * NIM);
  assert.equal(G.parts(b).wallet, 0);
  const st = G.sanitizeState({ v: 1, goals: [b] });
  assert.equal(st.goals[0].entries[0].ref, 'A');
  assert.equal(st.goals[0].entries[1].kind, 'spend');
});

test('state keeps the wallet accounts and the reward record, drops junk', () => {
  const st = G.sanitizeState({ v: 1, accounts: [OWNER, 42, 'x'.repeat(80), 'NQ43 MS6V'], rewards: { last: 5, since: 1, events: [{ at: 2, luna: 5 }, { at: 3, luna: -1 }, null, { at: 'x', luna: 2 }] } });
  assert.deepEqual(st.accounts, [OWNER, 'NQ43 MS6V']);
  assert.deepEqual(st.rewards, { last: 5, since: 1, events: [{ at: 2, luna: 5 }] });
  assert.equal(G.sanitizeState({ v: 1, rewards: { last: -3 } }).rewards, null);
  assert.equal(G.sanitizeState({ v: 1, rewards: 'x' }).rewards, null);
});

test('rewards: booked as they arrive, a day at a time, never while money is moving', () => {
  const day = (d, h = 3) => Date.UTC(2026, 10, d, h);
  let { rw, added } = R.trackRewards(null, 0, day(6));
  assert.deepEqual(rw, { last: 0, since: day(6), events: [] });
  assert.equal(added, 0);
  ({ rw, added } = R.trackRewards(rw, 49500, day(8)));
  assert.equal(added, 49500);
  assert.deepEqual(rw.events, [{ at: day(8), luna: 49500 }]);
  ({ rw } = R.trackRewards(rw, 60000, day(8, 15)));
  assert.deepEqual(rw.events, [{ at: day(8), luna: 60000 }]);
  ({ rw } = R.trackRewards(rw, 70000, day(9)));
  assert.equal(rw.events.length, 2);
  assert.deepEqual(R.lastReward(rw), { at: day(9), luna: 10000 });
  const frozen = R.trackRewards(rw, 99999, day(10), false);
  assert.equal(frozen.rw, rw);
  assert.equal(frozen.added, 0);
  ({ rw } = R.trackRewards(rw, 1000, day(10)));
  assert.equal(rw.last, 1000);
  assert.equal(rw.events.length, 2);
  for (const junk of [-1, NaN, 1.5, '7', undefined]) assert.equal(R.trackRewards(rw, junk, day(11)).rw, rw);
  let many = { last: 0, since: 0, events: [] };
  for (let d = 0; d < 80; d++) many = R.trackRewards(many, (d + 1) * 10, d * DAY + 1).rw;
  assert.equal(many.events.length, 60);
  assert.equal(R.lastReward(null), null);
});

test('Lightning invoices: the right network, an amount, nothing else', () => {
  const body = 'pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq';
  const main = `lnbc2500u1${body}`;
  assert.deepEqual(P.checkInvoice(main), { ok: true, invoice: main, kind: 'bolt11', sats: 250000 });
  assert.deepEqual(P.checkInvoice(`  LIGHTNING:${main.toUpperCase()}\n`), { ok: true, invoice: main, kind: 'bolt11', sats: 250000 });
  assert.equal(P.checkInvoice(`lnbc20m1${body}`).sats, 2000000);
  assert.equal(P.checkInvoice(`lnbc1101${body}`).sats, 110 * 1e8);
  assert.equal(P.checkInvoice(`lnbc1${body}`).reason, 'noAmount');
  assert.equal(P.checkInvoice(`lntb2500u1${body}`).reason, 'wrongNet');
  assert.equal(P.checkInvoice(`lntb2500u1${body}`, 'testnet').ok, true);
  assert.equal(P.checkInvoice(main, 'testnet').reason, 'wrongNet');
  assert.equal(P.checkInvoice(`lnbcrt2500u1${body}`).reason, 'wrongNet');
  const lnurl = 'lnurl1dp68gurn8ghj7um9wfmxjcm99e3k7mf0v9cxj0m385ekvcenxc6r2c35xvukxefcv5mkvv34x5ekzd3ev56nyd3hxqurzepexejxxepnxscrvwfnv9nxzcn9xq6xyefhvgcxxcmyxymnserxfq5fns';
  assert.deepEqual(P.checkInvoice(lnurl.toUpperCase()), { ok: true, invoice: lnurl, kind: 'lnurl', sats: null });
  for (const [bad, why] of [['', 'empty'], [null, 'empty'], ['   ', 'empty'], ['bitcoin:bc1qxyz', 'notLightning'], ['hello@getalby.com', 'notLightning'],
    [`lnbc2500u1${body}!`, 'notLightning'], ['lnbc2500u1short', 'notLightning'], [`lnbc2500x1${body}`, 'notLightning'], [`lnbc1p1${body}`, 'notLightning'],
    [`lnbc2500u1${body}${'q'.repeat(2048)}`, 'long'], [`lnbc2500u1${body}b`, 'notLightning']]) {
    assert.deepEqual(P.checkInvoice(bad), { ok: false, reason: why }, String(bad).slice(0, 40));
  }
  assert.equal(P.bolt11Sats('10p'), 0.001);
  assert.equal(P.bolt11Sats('1p'), null);
  assert.equal(P.bolt11Sats('1'), 1e8);
  assert.equal(P.bolt11Sats('x'), null);
});

test('wallet errors: a Lightning invoice paid twice is its own case', () => {
  assert.equal(W.classifyError({ type: 'DUPLICATE_PAYMENT', message: 'already submitted' }), 'duplicate');
  assert.equal(W.classifyError({ type: 'TRANSACTION_OUTCOME_UNKNOWN' }), 'unknown');
  assert.equal(W.classifyError({ type: 'INVALID_TRANSACTION', message: 'Bitcoin Lightning invoice expired' }), 'invalid');
});

test('every reason the invoice check gives has words in the app', async () => {
  const { dictionaries } = await import('../docs/js/i18n.js');
  const body = 'pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq';
  const reasons = new Set(['', 'x', `lnbc1${body}`, `lntb5u1${body}`, 'q'.repeat(3000)].map((x) => P.checkInvoice(x).reason));
  for (const r of reasons) for (const d of Object.values(dictionaries)) assert.ok(d[`spend.err.${r}`], r);
});
