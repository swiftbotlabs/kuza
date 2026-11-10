// The browser demo after the outside test of 10 Nov 2026 (430x932, as the tester ran it):
//  P. One pretend stake for every reader. Stake 500 NIM, then open the app in a second tab (as a new browser page or
//     a test runner's fresh page does): "Take some out" 100 goes through the real cooling-off, "Break this goal" offers
//     the real unstaking path for the rest, and the rewards sheet knows there is a stake. A goal whose pretend chain was
//     lost (cleared, damaged) gets it rebuilt from what the goals booked, never "no stake" beside "In your stake 500".
//  A. What a friend sees is labelled as what friends gave, in the share preview and on the friend's page.
//  B. A friend's pretend gift, sent in another tab of the same browser, reaches the owner's goal ("From friends", Activity),
//     comes out of the friend's pretend wallet, not the owner's.
//  C. The plan card's "this week is done" line reads naturally, in all four languages.
// Usage: node test/ui/drive-demo-stake.mjs <output dir>   (ports: KUZA_UI_PORT, KUZA_UI_CDP; another docs copy: KUZA_UI_ROOT;
//        the deployed site instead of the local copy: KUZA_UI_BASE=https://kuza.swiftbotlab.workers.dev/)
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serve, startChrome, newTab, sleep } from './harness.mjs';

const OUT = resolve(process.argv[2] || 'tmp-ui-demo-stake');
const PORT = Number(process.env.KUZA_UI_PORT) || 8155;
const CDP = Number(process.env.KUZA_UI_CDP) || 9365;
const NIM = 1e5;
const SIZE = { width: 430, height: 932 };

const checks = [];
const check = (name, ok) => { checks.push([name, Boolean(ok)]); console.log(ok ? 'ok  ' : 'FAIL', name); };
const text = (t, sel) => t.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText ?? '').replace(/\\s+/g, ' ').trim()`);
const tile = (t, label) => t.eval(`[...document.querySelectorAll('.tile')].find((x) => x.innerText.startsWith(${JSON.stringify(label)}))?.innerText.replace(/\\s+/g, ' ') || ''`);
const state = (t) => t.eval(`JSON.parse(localStorage.getItem('kuza.demo.mainnet'))`);
const front = (t) => t.call('Page.bringToFront');
// Every page of the demo gets the pretend stake's growth turned off (as the tester saw it: Earned +0), so amounts are exact.
const demoUp = async (t) => {
  for (let i = 0; i < 80 && !(await t.eval('!!window.__kuzaDemo')); i++) await sleep(100);
  await t.eval('window.__kuzaDemo && (window.__kuzaDemo.chain.noGrowth = true)');
};
const yes = async (t, title = 'Pretend wallet') => { await t.waitText(title, 8000); await tap(t, '[data-rig=demo-yes]'); };
const maybeYes = async (t) => { if ((await t.text()).includes('Pretend wallet')) await tap(t, '[data-rig=demo-yes]'); };
const poke = async (t, ms = 1500) => { await t.eval('document.dispatchEvent(new Event("visibilitychange"))'); await sleep(ms); };
const closeSheet = async (t) => { if (await t.has('[data-rig=sheet-close]')) { await tap(t, '[data-rig=sheet-close]'); await sleep(250); } };
/** Tap once the element is there (the drives run in parallel, so pages can be slow). */
const tap = async (t, sel) => { await t.waitFor(sel, 10000); await t.click(sel); };
/** A part that throws is one failed check, and the parts after it still run. */
const section = async (name, fn) => { try { await fn(); } catch (err) { console.log(String(err.message).slice(0, 1500)); check(`${name}: ran to the end (${String(err.message).split('\n')[0].slice(0, 120)})`, false); } };
const waitUntil = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(200); } return false; };

/** Walk a started cooling-off to the end: skip the wait, release, approve the sheets, let the app book it. */
async function land(t) {
  await t.eval('window.__kuzaDemo.skipCooling()');
  await poke(t, 400);
  await t.waitText('Cooling-off finished', 8000);
  await tap(t, '[data-rig=cool-card]');
  await t.waitText('move to my wallet');
  await tap(t, '[data-rig=wd-release]');
  await yes(t);
  await sleep(1500);
  await maybeYes(t);
  await sleep(2000);
  await poke(t, 2500);
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const server = await serve(PORT);
  const chrome = await startChrome(CDP, `${OUT}/profile`);
  try {
    const base = process.env.KUZA_UI_BASE || `http://127.0.0.1:${PORT}/`;
    // ---- P. The tester's steps, in one tab ----
    const a = await newTab(CDP, SIZE);
    await a.go(`${base}?demo=1&lang=en`);
    await a.eval('localStorage.clear(); sessionStorage.clear()');
    await a.eval(`localStorage.setItem('kuza.market', JSON.stringify({ at: Date.now(), value: { price: { usd: 0.00027 }, rate: 0.083 } }))`);
    await a.go(`${base}?demo=1&lang=en`, 1500);
    await demoUp(a);
    await a.eval('window.__kuzaDemo.chain.noGrowth = true'); // as the tester saw it: Earned +0 NIM
    await a.waitFor('[data-rig=connect]', 10000);
    await tap(a, '[data-rig=connect]');
    await yes(a);
    await a.waitText('Your goals');
    await tap(a, '[data-rig=new-goal]');
    await a.fill('[data-rig=f-name]', 'New laptop');
    await a.fill('[data-rig=f-target]', '5000');
    await a.fill('[data-rig=f-weekly]', '500');
    await tap(a, '[data-rig=f-submit]');
    await a.waitText('Make your first saving', 8000);
    await a.fill('[data-rig=s-amount]', '500');
    await a.waitText('Stake 500 NIM');
    await tap(a, '[data-rig=s-submit]');
    await yes(a);
    await a.waitText('Saved on-chain', 8000);
    await sleep(1500);
    const gid = (await state(a)).goals[0].id;
    const goalUrl = `${base}?demo=1&lang=en#/goal/${gid}`;
    check('setup: goal page shows 500 of 5,000 NIM, 500 in the stake', (await a.text()).includes('500 of 5,000 NIM') && (await tile(a, 'In your stake')).includes('500 NIM'));
    await a.shot(`${OUT}/s01-staked.png`);

    // ---- C. The plan card, this week's saving done ----
    const next = await text(a, '[data-rig=plan-next]');
    console.log('plan-next:', next);
    check('C: plan card says this week is done, then the next saving, with no "Done this week · 500 NIM from"', /^This week Done\. Next: 500 NIM from \w{3}, \w{3} \d{1,2}$/.test(next) && !next.includes('·'));
    for (const [code, re] of [
      ['es', /^Esta semana Hecho\. Próximo: 500 NIM desde el /],
      ['fr', /^Cette semaine Faite\. Prochaine : 500 NIM à partir du /],
      ['sw', /^Wiki hii Imekamilika\. Inayofuata: NIM 500 kuanzia |^Wiki hii Imekamilika\. Inayofuata: 500 NIM kuanzia /],
    ]) {
      await a.go(`${base}?demo=1&lang=${code}#/goal/${gid}`, 1500);
      await demoUp(a);
      await a.waitFor('[data-rig=plan-next]', 8000);
      const line = await text(a, '[data-rig=plan-next]');
      console.log(`plan-next ${code}:`, line);
      check(`C: plan card done line in ${code} reads "done, then next", no "·"`, re.test(line) && !line.includes('·'));
    }
    await a.go(goalUrl, 1500);
    await demoUp(a);

    // ---- P. A second tab of the same browser: a fresh page, as a test runner's new page or a phone's new tab ----
    const b = await newTab(CDP, SIZE);
    await section('P second tab', async () => {
    await front(b);
    await b.go(goalUrl, 1800);
    await demoUp(b);
    await b.eval('window.__kuzaDemo.chain.noGrowth = true');
    await b.waitText('New laptop', 8000);
    await sleep(1500);
    const seen = await b.eval('(() => { const s = window.__kuzaDemo.chain.staker; return s ? s.balance + s.inactiveBalance + s.retiredBalance : 0; })()');
    check('P: the second tab\'s pretend chain has the 500 NIM stake the goal booked', seen >= 500 * NIM);
    check('P: second tab, goal page: 500 of 5,000 NIM, In your stake 500 NIM', (await b.text()).includes('500 of 5,000 NIM') && (await tile(b, 'In your stake')).includes('500 NIM'));

    // Rewards sheet: knows there is a stake (after the app has read the stake and its history).
    await poke(b, 3000);
    await tap(b, '[data-rig=goal-earned]');
    await b.waitFor('[data-rig=rewards-sheet]');
    await sleep(1500);
    const rw = await text(b, '[data-rig=rewards-sheet]');
    console.log('rewards:', rw.slice(0, 200));
    check('P: rewards sheet recognises the stake (no "Rewards start once you have a stake", the pool is named)', !rw.includes('Rewards start once you have a stake') && (await b.has('[data-rig=rewards-sheet] .route')));
    await b.shot(`${OUT}/s02-rewards.png`);
    await closeSheet(b);

    // Take some out: 100 NIM, through the real cooling-off.
    await tap(b, '[data-rig=take-out]');
    await b.waitFor('[data-rig=takeout-sheet]');
    await b.fill('[data-rig=to-amount]', '100');
    await sleep(800);
    const to = await text(b, '[data-rig=takeout-sheet]');
    check('P: take out 100: no "The stake couldn\'t be read", the three steps with the cooling-off', !to.includes('couldn\'t be read') && to.includes('Cooling-off') && /in three steps/.test(to));
    check('P: take out 100: the button is on and goes on to the cooling-off', (await b.eval(`!document.querySelector('[data-rig=to-go]').disabled`)) && (await text(b, '[data-rig=to-go]')) === 'Continue to the cooling-off');
    await b.shot(`${OUT}/s03-take-out.png`);
    await tap(b, '[data-rig=to-go]');
    await b.waitFor('[data-rig=wd-takeout]');
    check('P: take-out cooling-off sheet pre-filled with 100', (await b.eval(`document.querySelector('[data-rig=w-amount]').value`)) === '100');
    await tap(b, '[data-rig=w-submit]');
    await yes(b);
    await sleep(500);
    await maybeYes(b);
    await b.waitText('Cooling-off', 8000);
    await sleep(1200);
    await land(b);
    const after1 = await b.text();
    check('P: take-out landed: 400 of 5,000 NIM, 400 in the stake', after1.includes('400 of 5,000 NIM') && (await tile(b, 'In your stake')).includes('400 NIM'));
    await b.shot(`${OUT}/s04-after-take-out.png`);

    // The rewards sheet still knows the stake.
    await tap(b, '[data-rig=goal-earned]');
    await b.waitFor('[data-rig=rewards-sheet]');
    await sleep(1200);
    check('P: after the take-out the rewards sheet still recognises the stake', !(await text(b, '[data-rig=rewards-sheet]')).includes('Rewards start once you have a stake'));
    await closeSheet(b);

    // Break the rest: the real unstaking path.
    await tap(b, '[data-rig=break]');
    await sleep(1200);
    const br = await text(b, '.sheet');
    check('P: break: the unstaking path (amount, three steps), not "There\'s no stake to take out"', !br.includes('no stake to take out') && br.includes('Stop earning') && br.includes('Cooling-off') && (await b.has('[data-rig=w-amount]')));
    const offered = await b.eval(`document.querySelector('[data-rig=w-amount]')?.value`);
    console.log('break offers', offered, JSON.stringify(await b.eval('window.__kuzaDemo.chain.staker')));
    // A page load may let the pretend stake grow by a block's reward before the test turns growth off (a few luna).
    check('P: break: the rest (400 and any reward) is offered', Math.abs(Number(offered) - 400) < 0.001);
    await b.shot(`${OUT}/s05-break.png`);
    await tap(b, '[data-rig=w-submit]');
    await yes(b);
    await sleep(500);
    await maybeYes(b);
    await b.waitText('Cooling-off', 8000);
    await sleep(1200);
    await land(b);
    console.log('end', JSON.stringify(await b.eval('(() => { const c = window.__kuzaDemo.chain; return { wallet: c.wallet, staker: c.staker, h: c.history.slice(0, 6).map((x) => [x.from.slice(-4), x.to.slice(-4), x.value, x.recipientData.slice(0, 2)]) }; })()')));
    const chainEnd = await b.eval('(() => { const c = window.__kuzaDemo.chain; return { wallet: c.wallet, staker: c.staker }; })()');
    const back = (w) => w >= 25000 * NIM && w < 25000 * NIM + 100;
    check('P: broken: the pretend stake is empty and the 500 NIM (and its few luna of reward) are back in the pretend wallet', !chainEnd.staker && back(chainEnd.wallet));
    check('P: broken: the goal shows 0 in the stake', (await tile(b, 'In your stake')).includes(' 0 NIM'));
    await b.shot(`${OUT}/s06-broken.png`);

    // The first tab sees the same chain (one pretend chain per browser, as one wallet would be).
    await front(a);
    await a.go(goalUrl, 1800);
    await demoUp(a);
    const chainA = await a.eval('(() => { const c = window.__kuzaDemo.chain; return { wallet: c.wallet, staker: c.staker }; })()');
    check('P: the first tab reads the same pretend chain afterwards (no stake, 25,000 in the wallet)', !chainA.staker && back(chainA.wallet));
    });

    // A lost pretend chain (cleared by hand) is rebuilt from what the goals booked, never "no stake".
    const c = await newTab(CDP, SIZE);
    let link = null;
    await section('P rebuilt', async () => {
    await front(a);
    await a.go(`${base}?demo=1&lang=en`, 900);
    await a.eval('localStorage.clear(); sessionStorage.clear()');
    await a.eval(`localStorage.setItem('kuza.market', JSON.stringify({ at: Date.now(), value: { price: { usd: 0.00027 }, rate: 0.083 } }))`);
    await a.go(`${base}?demo=1&lang=en`, 1500);
    await demoUp(a);
    await a.waitFor('[data-rig=connect]', 10000);
    await tap(a, '[data-rig=connect]');
    await yes(a);
    await a.waitText('Your goals');
    await tap(a, '[data-rig=new-goal]');
    await a.fill('[data-rig=f-name]', 'New laptop');
    await a.fill('[data-rig=f-target]', '5000');
    await a.fill('[data-rig=f-weekly]', '500');
    await tap(a, '[data-rig=f-submit]');
    await a.waitText('Make your first saving', 8000);
    await a.fill('[data-rig=s-amount]', '500');
    await a.waitText('Stake 500 NIM');
    await tap(a, '[data-rig=s-submit]');
    await yes(a);
    await a.waitText('Saved on-chain', 8000);
    await sleep(1500);
    const gid2 = (await state(a)).goals[0].id;
    // Only the goals are kept: every pretend-chain copy goes, as in a browser whose demo chain was lost (no demo tab open).
    await b.go('about:blank', 200);
    await a.eval(`(() => { const keep = localStorage.getItem('kuza.demo.mainnet'); const m = localStorage.getItem('kuza.market'); localStorage.clear(); sessionStorage.clear(); localStorage.setItem('kuza.demo.mainnet', keep); localStorage.setItem('kuza.market', m); })()`);
    await front(c);
    await c.go(`${base}?demo=1&lang=en#/goal/${gid2}`, 1800);
    await demoUp(c);
    await c.waitText('New laptop', 8000);
    await sleep(1500);
    const rebuilt = await c.eval('(() => { const c = window.__kuzaDemo.chain; return { wallet: c.wallet, stake: c.staker ? c.staker.balance : null }; })()');
    console.log('rebuilt', JSON.stringify(rebuilt), JSON.stringify(await c.eval('window.__kuzaDemo.chain.history.map((x) => [x.from.slice(-4), x.to.slice(-6), x.value, x.recipientData.slice(0, 4)])')));
    check('P: pretend chain lost: rebuilt from the goals (500 staked, 24,500 in the wallet)', rebuilt.stake !== null && rebuilt.stake >= 500 * NIM && rebuilt.stake < 501 * NIM && rebuilt.wallet === 24500 * NIM);
    // A damaged copy (and every tab reloaded): rebuilt the same way.
    await a.go('about:blank', 200);
    await c.eval(`localStorage.setItem('kuza.demo.chain', '{not json')`);
    await c.go(`${base}?demo=1&lang=en#/goal/${gid2}`, 1800);
    await demoUp(c);
    await c.waitText('New laptop', 8000);
    const again = await c.eval('(() => { const c = window.__kuzaDemo.chain; return { wallet: c.wallet, stake: c.staker ? c.staker.balance : null, txs: c.history.length }; })()');
    check('P: pretend chain damaged: the goals\' 500 staked (by one deposit, plus any block reward), 24,500 in the wallet', again.stake >= 500 * NIM && again.stake < 500 * NIM + 100 && again.wallet === 24500 * NIM && again.txs === 1);
    console.log('after the damaged copy', JSON.stringify(again));
    await tap(c, '[data-rig=take-out]');
    await c.waitFor('[data-rig=takeout-sheet]');
    await c.fill('[data-rig=to-amount]', '100');
    await sleep(800);
    check('P: rebuilt chain: take out 100 goes on to the cooling-off', !(await text(c, '[data-rig=takeout-sheet]')).includes('couldn\'t be read') && (await c.eval(`!document.querySelector('[data-rig=to-go]').disabled`)));
    await closeSheet(c);
    await poke(c, 3000);
    await tap(c, '[data-rig=goal-earned]');
    await c.waitFor('[data-rig=rewards-sheet]');
    await sleep(1500);
    const rw2 = await text(c, '[data-rig=rewards-sheet]');
    check('P: rebuilt chain: rewards sheet recognises the stake and books no fake reward (0 earned)', !rw2.includes('Rewards start once you have a stake') && !/\+[1-9][\d,]* NIM/.test(rw2));
    await closeSheet(c);
    });

    // ---- A. What friends see ----
    await section('A share', async () => {
    await tap(c, '[data-rig=share]');
    await c.waitFor('[data-rig=share-preview]');
    const pv = await text(c, '[data-rig=share-preview]');
    console.log('preview:', pv);
    check('A: share preview labels the number as what friends gave (0 NIM from friends), not total saved', /0 NIM from friends/.test(pv) && !/0 of 5,000 NIM so far/.test(pv));
    check('A: share preview says the owner\'s own saving is not shown to friends', (await c.text()).includes('not what you save yourself'));
    await c.shot(`${OUT}/s07-share-preview.png`);
    link = await c.eval(`document.querySelector('[data-rig=share-link]').value`);
    await closeSheet(c);
    });

    // ---- B. A friend chips in from another tab of the same browser ----
    const f = await newTab(CDP, SIZE);
    await section('B gift', async () => {
    const fUrl = link.replace(/^https:\/\/kuza\.swiftbotlab\.workers\.dev\//, base).replace('?demo=1&', '?demo=1&lang=en&');
    const ownerWallet = await c.eval('window.__kuzaDemo.chain.wallet');
    await front(f);
    await f.go(fUrl, 1800);
    await demoUp(f);
    await f.waitText('Add to this goal', 8000);
    await sleep(1200);
    const hero = await text(f, '[data-rig=jar-hero]');
    console.log('friend hero:', hero);
    check('A: friend page labels its number as from friends', /0 NIM from friends/.test(hero));
    await f.fill('[data-rig=j-amount]', '100');
    await f.fill('[data-rig=j-note]', 'For the laptop');
    await tap(f, '[data-rig=j-send]');
    await yes(f, 'Connect to Kuza');
    await f.waitText('KZ1|', 8000);
    await tap(f, '[data-rig=demo-yes]');
    await f.waitFor('[data-rig=thanks]', 10000);
    await sleep(1000);
    const thanks = await text(f, '[data-rig=thanks-total]');
    check('A: thank-you total is labelled from friends (100 NIM from friends)', /100 NIM from friends/.test(thanks));
    await f.shot(`${OUT}/s08-friend-thanks.png`);
    const after = await f.eval('(() => { const c = window.__kuzaDemo.chain; return { wallet: c.wallet, friend: c.friendWallet }; })()');
    check('B: the gift came out of the friend\'s pretend wallet and landed in the owner\'s', after.wallet === ownerWallet + 100 * NIM && after.friend === 24900 * NIM);
    check('B: the thank-you page says the pretend gift reaches the goal made in this browser', (await text(f, '[data-rig=thanks-demo]')).includes('New laptop was made in this browser'));
    // The owner's tab, still open: the gift shows up without a reload.
    await front(c);
    await poke(c, 300);
    const got = await waitUntil(async () => (await tile(c, 'From friends')).includes('100 NIM'), 12000);
    check('B: owner tab: From friends 100 NIM after the friend\'s gift', got);
    check('B: owner tab: Activity lists the gift with its note', (await c.text()).includes('For the laptop') && (await c.text()).includes('+100 NIM'));
    await c.shot(`${OUT}/s09-owner-gift.png`);
    });
    for (const tab of [a, b, c, f]) check(`no page errors (${tab === a ? 'a' : tab === b ? 'b' : tab === c ? 'c' : 'friend'})`, !tab.errors.length || console.log(tab.errors));
  } finally {
    await chrome.stop();
    server.close();
  }
  const failed = checks.filter(([, ok]) => !ok);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  if (!checks.length || failed.length) process.exit(1);
}

main().catch((err) => { console.error('FAIL', err.message.slice(0, 900)); process.exit(1); });
