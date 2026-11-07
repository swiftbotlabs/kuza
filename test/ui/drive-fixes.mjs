// The fixes after outside testing (7 Nov 2026), walked through in the browser demo at phone size: ordinary names with
// dots, amounts typed with separators, a plan's first saving, using the money of a goal that is all in the stake,
// expired invoices, taking everything out (the goal keeps its NIM and rewards until they are spent), what a payment
// books, demo links that stay in the demo, and a friend's note checked before it is sent.
// Usage: node test/ui/drive-fixes.mjs <output dir>   (ports: KUZA_UI_PORT, KUZA_UI_CDP; another docs copy: KUZA_UI_ROOT;
//        the deployed site instead of the local copy: KUZA_UI_BASE=https://kuza.swiftbotlab.workers.dev/)
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serve, startChrome, newTab, sleep } from './harness.mjs';
import { ln, SPEC_COFFEE } from '../fixtures/lightning.mjs';

const OUT = resolve(process.argv[2] || 'tmp-ui-fixes');
const PORT = Number(process.env.KUZA_UI_PORT) || 8129;
const CDP = Number(process.env.KUZA_UI_CDP) || 9339;
const NIM = 1e5;

const checks = [];
const check = (name, ok) => { checks.push([name, Boolean(ok)]); console.log(ok ? 'ok  ' : 'FAIL', name); };
const state = (t) => t.eval(`JSON.parse(localStorage.getItem('kuza.demo.mainnet'))`);
const text = (t, sel) => t.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText ?? '').replace(/\\s+/g, ' ')`);
const errText = (t) => t.eval(`document.querySelector('.sheet .tiny.bad')?.textContent || ''`);
const tile = (t, label) => t.eval(`[...document.querySelectorAll('.tile')].find((x) => x.innerText.startsWith(${JSON.stringify(label)}))?.innerText.replace(/\\s+/g, ' ') || ''`);
const closeSheet = async (t) => { await t.click('[data-rig=sheet-close]'); await sleep(250); };
const demoUp = async (t) => {
  for (let i = 0; i < 80 && !(await t.eval('!!window.__kuzaDemo')); i++) await sleep(100);
  await t.eval('window.__kuzaDemo.chain.noGrowth = true');
};
const yes = async (t, title = 'Pretend wallet') => { await t.waitText(title, 8000); await t.click('[data-rig=demo-yes]'); };
const poke = async (t, ms = 1800) => { await t.eval('document.dispatchEvent(new Event("visibilitychange"))'); await sleep(ms); };

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const server = await serve(PORT);
  const chrome = await startChrome(CDP, `${OUT}/profile`);
  const tabs = [];
  try {
    const base = process.env.KUZA_UI_BASE || `http://127.0.0.1:${PORT}/`;
    const t = await newTab(CDP);
    tabs.push(t);
    await t.go(`${base}?demo=1&lang=en`);
    await t.eval('localStorage.clear(); sessionStorage.clear()');
    await t.eval(`localStorage.setItem('kuza.market', JSON.stringify({ at: Date.now(), value: { price: { usd: 0.00027 }, rate: 0.083 } }))`);
    await t.go(`${base}?demo=1&lang=en`);
    await demoUp(t);
    await t.click('[data-rig=connect]');
    await yes(t);
    await t.waitText('Your goals');

    // ---- A3 + A4: the goal form ----
    await t.click('[data-rig=new-goal]');
    await t.fill('[data-rig=f-name]', 'Fees at t.me/nimiqhelp');
    await t.fill('[data-rig=f-target]', '1000');
    await t.click('[data-rig=f-submit]');
    await sleep(150);
    check('goal form: a name with an address in it is still refused', (await errText(t)).includes('Leave web addresses out'));
    await t.fill('[data-rig=f-name]', 'B.Sc fees');
    await t.fill('[data-rig=f-target]', '1,000');
    await t.click('[data-rig=f-submit]');
    await sleep(150);
    check('goal form: "1,000" says to type it without separators (not "at least 1 NIM")', (await errText(t)).includes('without separators') && !(await errText(t)).includes('at least 1'));
    await t.shot(`${OUT}/f01-separators.png`);
    check('goal form: "B.Sc fees" is not taken for a web address', !(await errText(t)).includes('web addresses'));
    await t.fill('[data-rig=f-target]', '1000');
    await t.fill('[data-rig=f-weekly]', '250');
    await t.click('[data-rig=f-submit]');
    await t.waitText('Make your first saving');
    await sleep(300);
    const s1 = await state(t);
    check('goal form: "B.Sc fees" is saved as typed', s1.goals.length === 1 && s1.goals[0].name === 'B.Sc fees');

    // ---- A5: the first saving follows the plan ----
    check('first saving: the plan\'s 250 is filled in, not the 1,000 target', (await t.eval(`document.querySelector('[data-rig=s-amount]').value`)) === '250'
      && (await text(t, '[data-rig=s-submit]')).includes('Stake 250 NIM'));
    check('first saving: the note says it is this week\'s plan saving', (await text(t, '[data-rig=s-suggested]')).includes("This week's saving in your plan"));
    await t.shot(`${OUT}/f02-first-saving-plan.png`);
    await t.fill('[data-rig=s-amount]', '1,000');
    check('save sheet: "1,000" gets the separators message', (await text(t, '.sheet .route')).includes('without separators'));
    await t.fill('[data-rig=s-amount]', '250');
    check('save sheet: typing the suggested amount by hand does not bring the suggestion note back', await t.eval(`document.querySelector('[data-rig=s-suggested]').hidden`));
    await t.fill('[data-rig=s-amount]', '1000');
    await t.waitText('Stake 1,000 NIM');
    await t.click('[data-rig=s-submit]');
    await yes(t);
    await t.waitFor('[data-rig=reached-sheet]', 10000);
    await sleep(700);

    // ---- A1: all in the stake: no payment from other money ----
    await t.click('[data-rig=rs-use]');
    await t.waitFor('[data-rig=use-sheet]');
    check('use it, all in the stake: no "Pay" (it would come from other money), says when it can', !(await t.has('[data-rig=use-pay]')) && (await text(t, '[data-rig=use-pay-later]')).includes('back in your wallet'));
    await t.shot(`${OUT}/f03-use-all-staked.png`);
    await closeSheet(t);

    // ---- B1 + B3: a reward, then take everything out ----
    await t.eval('window.__kuzaDemo.reward(25 * 100000)');
    await poke(t, 2500);
    check('before taking out: the goal\'s Earned tile shows the +25 reward', (await text(t, '[data-rig=goal-earned-v]')) === '+25 NIM');
    await t.click('[data-rig=break]');
    await t.waitText('Leaving takes time');
    await t.fill('[data-rig=w-amount]', '1025');
    await t.click('[data-rig=w-submit]');
    await yes(t);
    await sleep(500);
    if ((await t.text()).includes('Pretend wallet')) await t.click('[data-rig=demo-yes]');
    await t.waitText('Cooling-off', 6000);
    await t.eval('window.__kuzaDemo.skipCooling()');
    await poke(t, 300);
    await t.waitText('Cooling-off finished', 6000);
    await t.click('[data-rig=cool-card]');
    await t.waitText('Finish: move to my wallet');
    await t.click('[data-rig=wd-release]');
    await yes(t);
    await sleep(1500);
    await yes(t);
    await t.waitText('Back in your wallet', 8000);
    await sleep(1500);
    await poke(t, 2500);
    const g2 = (await state(t)).goals[0];
    const w = g2.entries.find((e) => e.kind === 'withdraw');
    check('taken out: booked as the goal\'s own, back in the wallet, with its 25 NIM of rewards', w && w.toWallet === true && w.luna === 1000 * NIM && w.earned === 25 * NIM);
    check('taken out: the goal still shows 100% and 1,025 NIM set aside', (await text(t, '.goal-hero')).includes('100%') && (await tile(t, 'Set aside')).includes('1,025 NIM'));
    check('taken out: "Your NIM is back in your wallet" with Pay; no "ready to stake" card next to it', (await text(t, '[data-rig=spend-card]')).includes('back in your wallet') && (await t.has('[data-rig=spend-pay]')) && !(await t.has('[data-rig=stake-wallet]')));
    check('taken out: the goal\'s Earned tile still shows the +25 it earned', (await text(t, '[data-rig=goal-earned-v]')) === '+25 NIM');
    await t.shot(`${OUT}/f04-taken-out.png`);
    await t.click('[data-rig=goal-earned]');
    await t.waitFor('[data-rig=rw-total]');
    check('rewards sheet from the goal: the total and the goal\'s part agree with its tile', (await text(t, '[data-rig=rw-total]')).includes('25 NIM') && (await text(t, '[data-rig=rw-goal]')).includes('+25 NIM of it belongs to B.Sc fees'));
    await t.shot(`${OUT}/f05-rewards-from-goal.png`);
    await closeSheet(t);
    await t.eval('location.hash = "#/"');
    await sleep(900);
    const nudge = await text(t, '[data-rig=wallet-nudge]');
    check('home: the wallet line does not count the goal\'s own NIM as free, nor offer to add it back to the same goal', !nudge.includes('Add to B.Sc fees') && !nudge.includes('20,825'));
    await t.shot(`${OUT}/f06-home-after.png`);
    await t.eval(`document.querySelector('.card.goal')?.click()`);
    await sleep(500);
    check('plan card: the week still counts while the NIM is the goal\'s (streak kept)', (await text(t, '[data-rig=plan-card]')).includes('1 week in a row'));

    // ---- A2 + A1: the pay sheet, an expired invoice, a payment bigger than the goal ----
    await t.click('[data-rig=spend-pay]');
    await t.waitFor('[data-rig=ln-sheet]');
    check('pay sheet: says what this goal holds in the wallet', (await text(t, '[data-rig=ln-holds]')).includes('This goal has 1,025 NIM in your wallet'));
    await t.fill('[data-rig=ln-input]', SPEC_COFFEE);
    check('pay sheet: the 2017 BOLT11 example is refused as expired, Pay stays off', (await text(t, '[data-rig=ln-msg]')).includes('has expired') && (await t.eval(`document.querySelector('[data-rig=ln-pay]').disabled`)));
    await t.shot(`${OUT}/f07-expired.png`);
    const walletBefore = await t.eval('window.__kuzaDemo.chain.wallet');
    await t.fill('[data-rig=ln-input]', ln('lnbc2500u'));
    check('pay sheet: a fresh invoice is accepted', (await text(t, '[data-rig=ln-msg]')).includes('250,000 sats'));
    await t.click('[data-rig=ln-pay]');
    await yes(t, 'Pay with Bitcoin Lightning');
    await t.waitText('Paid a Lightning invoice', 8000);
    await sleep(2500);
    const paid = walletBefore - (await t.eval('window.__kuzaDemo.chain.wallet'));
    const sp = (await state(t)).goals[0].entries.find((e) => e.kind === 'spend');
    check('payment: booked against the goal only up to the 1,025 NIM it held; the whole payment kept for the history', paid === 4200 * NIM && sp.luna === 1025 * NIM && sp.paid === 4200 * NIM);
    check('payment: the history says −1,025 NIM and 4,200 NIM paid in all', (await t.text()).includes('−1,025 NIM') && (await text(t, '[data-rig=spend-rest]')).includes('4,200 NIM paid in all'));
    check('payment: the goal is at 0% and the card offers only "Mark as done"', (await text(t, '.goal-hero')).includes('0%') && (await text(t, '[data-rig=spend-card]')).includes('Nothing left in this goal') && !(await t.has('[data-rig=spend-pay]')) && (await t.has('[data-rig=spend-done]')));
    check('plan card: no "Done this week" and no streak once everything was spent', !(await text(t, '[data-rig=plan-card]')).includes('Done this week') && !(await text(t, '[data-rig=plan-card]')).includes('in a row'));
    await t.shot(`${OUT}/f08-after-payment.png`);

    // ---- A6: demo proof links ----
    const hrefs = await t.eval(`[...document.querySelectorAll('a')].map((a) => a.href).filter((x) => /nimiq\\.watch/.test(x))`);
    check('demo: no "View on chain" link to the real explorer for a pretend hash; labelled instead', hrefs.length === 0 && (await t.has('[data-rig=proof-demo]')) && (await text(t, '[data-rig=proof-demo]')).includes('Pretend'));

    // ---- B5: the demo invite link stays in the demo ----
    await t.click('[data-rig=share]');
    await t.waitFor('[data-rig=share-link]');
    const link = await t.eval(`document.querySelector('[data-rig=share-link]').value`);
    check('demo invite link keeps ?demo=1', link.startsWith('https://kuza.swiftbotlab.workers.dev/?demo=1&j=m'));
    await closeSheet(t);
    const f = await newTab(CDP);
    tabs.push(f);
    const rpc = [];
    await f.fakeRpc((method, params) => { rpc.push(method); return method === 'getTransactionsByAddress' ? [] : null; });
    // A friend's phone: none of the owner's goals (same origin here, so the owner's are cleared; their checks are done).
    await f.go(`${base}?demo=1&lang=en`, 600);
    await f.eval('localStorage.clear(); sessionStorage.clear()');
    await f.go(link.replace('https://kuza.swiftbotlab.workers.dev/', base), 1500);
    await demoUp(f);
    await f.waitText('Add to this goal', 8000);
    console.log('rpc calls', rpc.length, rpc.slice(0, 3)); check('demo invite opened: the friend view of the demo, and not one call to the real network', rpc.length === 0 && (await f.text()).includes('Demo with pretend NIM'));
    // ---- A3: the friend's note is checked before it goes on chain ----
    await f.fill('[data-rig=j-amount]', '10');
    await f.fill('[data-rig=j-note]', 'Ask t.me/nimiqhelp');
    await f.click('[data-rig=j-send]');
    await sleep(400);
    check('friend: a link-like note is stopped before anything is sent, and says why', (await f.eval(`document.querySelector('[data-rig=j-form] .tiny.bad')?.textContent || ''`)).includes('would only see "Gift"') && !(await f.text()).includes('Pretend wallet'));
    await f.shot(`${OUT}/f09-friend-note-refused.png`);
    await f.fill('[data-rig=j-note]', 'For your B.Sc fees, from auntie');
    await f.click('[data-rig=j-send]');
    await yes(f, 'Connect to Kuza');
    await f.waitText('KZ1|', 8000);
    check('friend: a note with "B.Sc" goes through to the wallet as written', (await f.text()).includes('For your B.Sc fees, from auntie'));
    await f.click('[data-rig=demo-yes]');
    await f.waitFor('[data-rig=thanks]', 10000);
    await sleep(800);
    check('friend: thank-you proof is labelled pretend in the demo, not linked', (await f.has('[data-rig=thanks-proof]')) && (await f.eval(`document.querySelector('[data-rig=thanks-proof]').tagName`)) === 'SPAN');
    check('friend: still no call to the real network', rpc.length === 0);

    for (const x of tabs) {
      check(`no horizontal scroll at 390 px (${x === t ? 'owner' : 'friend'})`, await x.noHScroll());
      check(`no script errors or CSP violations (${x === t ? 'owner' : 'friend'})`, x.errors.length === 0 && x.csp.length === 0);
      if (x.errors.length || x.csp.length) console.log(x.errors, x.csp);
    }
  } catch (e) {
    check(`drive ran to the end: ${String(e.message).split('\n')[0]}`, false);
    console.log(e.message.slice(0, 900));
  } finally {
    await chrome.stop();
    server.close();
  }
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed || checks.length < 30 ? 1 : 0);
}

main();
