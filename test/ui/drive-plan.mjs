// The fixes after the iPhone test (8 Nov 2026), walked through in the browser demo at phone size:
// 1. the plan math: one calculation for the home card, the goal page's badge, its pace line and its suggestion; a
//    goal made today is never "behind"; the plan and the suggestion are the same whole number.
// 2. "Take some out": part of a goal's NIM back without deleting it, from the wallet part at once, the staked part
//    through the real cooling-off, taken off the goal only when it lands.
// The page clock is moved with a test-only offset (Date.now), so "a week later" needs no waiting.
// Usage: node test/ui/drive-plan.mjs <output dir>   (ports: KUZA_UI_PORT, KUZA_UI_CDP; another docs copy: KUZA_UI_ROOT;
//        the deployed site instead of the local copy: KUZA_UI_BASE=https://kuza.swiftbotlab.workers.dev/)
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serve, startChrome, newTab, sleep } from './harness.mjs';

const OUT = resolve(process.argv[2] || 'tmp-ui-plan');
const PORT = Number(process.env.KUZA_UI_PORT) || 8133;
const CDP = Number(process.env.KUZA_UI_CDP) || 9343;
const NIM = 1e5;
const DAY = 864e5;

const checks = [];
const check = (name, ok) => { checks.push([name, Boolean(ok)]); console.log(ok ? 'ok  ' : 'FAIL', name); };
const state = (t) => t.eval(`JSON.parse(localStorage.getItem('kuza.demo.mainnet'))`);
const text = (t, sel) => t.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText ?? '').replace(/\\s+/g, ' ').trim()`);
const tile = (t, label) => t.eval(`[...document.querySelectorAll('.tile')].find((x) => x.innerText.startsWith(${JSON.stringify(label)}))?.innerText.replace(/\\s+/g, ' ') || ''`);
const closeSheet = async (t) => { await t.click('[data-rig=sheet-close]'); await sleep(250); };
const demoUp = async (t) => {
  for (let i = 0; i < 80 && !(await t.eval('!!window.__kuzaDemo')); i++) await sleep(100);
  await t.eval('window.__kuzaDemo.chain.noGrowth = true');
};
const yes = async (t, title = 'Pretend wallet') => { await t.waitText(title, 8000); await t.click('[data-rig=demo-yes]'); };
const poke = async (t, ms = 1800) => { await t.eval('document.dispatchEvent(new Event("visibilitychange"))'); await sleep(ms); };
const num = (s) => (String(s).match(/\d[\d,]*/) || [''])[0];
// Test-only clock offset, read before the app's scripts run.
const CLOCK = `(() => { try { const off = Number(localStorage.getItem('test.clock')) || 0; if (off) { const n = Date.now; Date.now = () => n() + off; } } catch {} })();`;
const setClock = (t, ms) => t.eval(`localStorage.setItem('test.clock', '${ms}')`);
// A real reload (a hash-only change would keep the page, and its clock), then the demo hooks again.
const open = async (t, url, wait = 1500) => { await t.go('about:blank', 150); await t.go(url, wait); await demoUp(t); };

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
    await t.call('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK });
    await t.go(`${base}?demo=1&lang=en`);
    await t.eval('localStorage.clear(); sessionStorage.clear()');
    await t.eval(`localStorage.setItem('kuza.market', JSON.stringify({ at: Date.now(), value: { price: { usd: 0.00027 }, rate: 0.083 } }))`);
    await t.go(`${base}?demo=1&lang=en`);
    await demoUp(t);
    await t.click('[data-rig=connect]');
    await yes(t);
    await t.waitText('Your goals');

    // ---- 1. A very large goal, made now, nothing saved ----
    await t.click('[data-rig=new-goal]');
    await t.fill('[data-rig=f-name]', 'House');
    await t.fill('[data-rig=f-target]', '10000000');
    // 20 weeks and 3 days away: 21 weekly savings fit before that day begins.
    await t.fill('[data-rig=f-date]', new Date(Date.now() + 20 * 7 * DAY + 3 * DAY).toISOString().slice(0, 10));
    const field = await t.eval(`document.querySelector('[data-rig=f-weekly]').value`);
    const hint = await text(t, '[data-rig=f-hint]');
    check('form: the plan field and the suggestion are the same whole number (476,191 a week for 21 weeks)', field === '476191' && hint.includes('476,191 NIM a week for 21 weeks'));
    await t.click('[data-rig=f-submit]');
    await t.waitText('Make your first saving');
    await closeSheet(t);
    const gid = (await state(t)).goals[0].id;
    // A minute later, and again 30 s on: nothing is due yet, so no "behind" anywhere.
    await setClock(t, 60e3);
    await open(t, `${base}?demo=1&lang=en#/`, 1500);
    check('the page clock runs a minute ahead (the offset took)', Math.abs((await t.eval('Date.now() - new Date().getTime()')) - 60e3) < 50);
    const home1 = await text(t, `[data-rig=goal-${gid}]`);
    check('home, a minute old, nothing saved: no "behind"', !/behind/.test(home1));
    await t.shot(`${OUT}/p01-home-new-goal.png`);
    await setClock(t, 90e3);
    await open(t, `${base}?demo=1&lang=en#/goal/${gid}`, 1500);
    const card1 = await text(t, '[data-rig=plan-card]');
    check('goal page, same goal: no "behind", no "after your date" line', !/behind/.test(card1) && !(await t.has('[data-rig=plan-late]')) && !/behind/.test(await t.text()));
    const byDate = (await text(t, '.goal-hero')).match(/By (.+)$/)?.[1];
    check('goal page: plan 476,191 a week, and the pace line lands on the date itself ("By" day = "At this pace" day)', card1.includes('Plan: 476,191 NIM a week') && byDate && (await text(t, '[data-rig=plan-finish-day]')) === byDate);
    await t.eval(`document.querySelector('[data-rig=plan-card]').scrollIntoView({ block: 'center' })`);
    await sleep(200);
    await t.shot(`${OUT}/p02-plan-card-new-goal.png`);

    // ---- A week and a day later, still nothing saved: one week is due ----
    await setClock(t, 8 * DAY);
    await open(t, `${base}?demo=1&lang=en#/`, 1500);
    check('the page clock runs 8 days ahead', Math.abs((await t.eval('Date.now() - new Date().getTime()')) - 8 * DAY) < 50);
    const chipHome = await text(t, `[data-rig=goal-${gid}] [data-rig=pace-chip]`);
    await t.shot(`${OUT}/p03-home-week-later.png`);
    await open(t, `${base}?demo=1&lang=en#/goal/${gid}`, 1500);
    const chipPage = await text(t, '[data-rig=plan-status] .chip');
    check('a week later: home card and goal page say the same thing, the one week owed (476,191 NIM behind)', chipHome === '476,191 NIM behind' && chipPage === chipHome);
    const late = await text(t, '[data-rig=plan-late]');
    check('a week later: the "gets you there" line asks 500,000 a week for the 20 weeks left', late.includes('About 500,000 NIM a week'));
    await t.eval(`document.querySelector('[data-rig=plan-card]').scrollIntoView({ block: 'center' })`);
    await sleep(200);
    await t.shot(`${OUT}/p04-plan-card-week-later.png`);
    await t.click('[data-rig=edit]');
    await t.waitFor('[data-rig=f-hint]');
    check('edit form: suggests the same 500,000 a week for 20 weeks as the plan card', (await text(t, '[data-rig=f-hint]')).includes('500,000 NIM a week for 20 weeks'));
    await closeSheet(t);
    await setClock(t, 0);

    // ---- 2. Take some out ----
    await open(t, `${base}?demo=1&lang=en#/`, 1200);
    await t.click('[data-rig=new-goal]');
    await t.fill('[data-rig=f-name]', 'School fees');
    await t.fill('[data-rig=f-target]', '1000');
    await t.fill('[data-rig=f-weekly]', '60');
    await t.click('[data-rig=f-submit]');
    await sleep(900);
    // After a reload Nimiq Pay asks to connect again, once per visit, before the first saving.
    if ((await t.text()).includes('Pretend wallet')) await t.click('[data-rig=demo-yes]');
    await t.waitText('Make your first saving', 8000);
    await t.fill('[data-rig=s-amount]', '60');
    await sleep(200);
    await t.click('[data-rig=s-submit]');
    await sleep(600);
    if ((await t.text()).includes('Pretend wallet')) await t.click('[data-rig=demo-yes]');
    await sleep(1200);
    let goal = (await state(t)).goals.find((g) => g.name === 'School fees');
    check('setup: 60 NIM set aside in the wallet (under the 100 NIM to stake)', goal && goal.entries.some((e) => e.kind === 'aside' && e.luna === 60 * NIM));
    await t.eval(`location.hash = '#/goal/${goal.id}'`);
    await sleep(700);
    check('goal page: "Take some out" sits with "Add to goal"; "Delete goal" is still a separate link', (await t.has('.actions [data-rig=take-out]')) && (await text(t, '[data-rig=take-out]')) === 'Take some out' && (await t.has('.links [data-rig=delete]')));
    check('plan card before: this week met (60 of 60)', (await text(t, '[data-rig=plan-card]')).includes('1 week in a row'));
    await t.shot(`${OUT}/p05-goal-take-some-out-link.png`);
    await t.click('[data-rig=take-out]');
    await t.waitFor('[data-rig=takeout-sheet]');
    check('take-out sheet: shows 60 NIM ready now and 0 in the stake', (await text(t, '[data-rig=to-ready]')).includes('60 NIM') && (await text(t, '[data-rig=to-staked]')).includes('0 NIM'));
    await t.fill('[data-rig=to-amount]', '1,000');
    check('take-out sheet: "1,000" gets the separators message, button off', (await text(t, '[data-rig=to-msg]')).includes('without separators') && (await t.eval(`document.querySelector('[data-rig=to-go]').disabled`)));
    await t.fill('[data-rig=to-amount]', '500');
    check('take-out sheet: more than the goal holds is refused, button off', (await text(t, '[data-rig=to-msg]')).includes('This goal holds 60 NIM') && (await t.eval(`document.querySelector('[data-rig=to-go]').disabled`)));
    await t.fill('[data-rig=to-amount]', '20');
    check('take-out sheet: 20 from the wallet part: no transaction, nothing to wait for', (await text(t, '[data-rig=to-msg]')).includes('no transaction') && (await text(t, '[data-rig=to-go]')) === 'Take out 20 NIM');
    await t.shot(`${OUT}/p06-take-out-wallet-part.png`);
    const walletBefore = await t.eval('window.__kuzaDemo.chain.wallet');
    await t.click('[data-rig=to-go]');
    await sleep(600);
    check('no wallet approval was asked for a wallet-part take-out', !(await t.text()).includes('Pretend wallet'));
    goal = (await state(t)).goals.find((g) => g.name === 'School fees');
    check('taken out: booked as "out" 20 NIM; the goal is still there with 40 NIM set aside', goal.entries.some((e) => e.kind === 'out' && e.luna === 20 * NIM) && (await tile(t, 'Set aside')).includes('40 NIM'));
    check('taken out: no NIM moved on the chain', (await t.eval('window.__kuzaDemo.chain.wallet')) === walletBefore);
    check('history: "Taken out for you −20 NIM"', (await t.text()).includes('Taken out for you') && (await t.text()).includes('−20 NIM'));
    check('plan card: the take-out is not counted as saving (40 of 60: week not met, no streak)', !(await text(t, '[data-rig=plan-card]')).includes('in a row'));
    await t.shot(`${OUT}/p07-after-wallet-take-out.png`);

    // ---- Staked part: stake 300 more, then take 200 out (40 from the wallet part, 160 from the stake) ----
    await t.click('[data-rig=save]');
    await t.waitFor('[data-rig=s-amount]');
    await t.fill('[data-rig=s-amount]', '300');
    await sleep(200);
    await t.click('[data-rig=s-submit]');
    await yes(t);
    await sleep(2500);
    await poke(t, 1500);
    goal = (await state(t)).goals.find((g) => g.name === 'School fees');
    const staked = goal.entries.filter((e) => e.kind === 'stake' && e.status === 'ok').reduce((n, e) => n + e.luna, 0);
    const wpart = (await tile(t, 'Set aside'));
    console.log('after staking: stake entries', staked / NIM, 'set aside tile', wpart);
    await t.click('[data-rig=take-out]');
    await t.waitFor('[data-rig=takeout-sheet]');
    const ready = num(await text(t, '[data-rig=to-ready]'));
    await t.fill('[data-rig=to-amount]', '200');
    const mixed = await text(t, '[data-rig=to-msg]');
    check('take-out sheet, partly staked: says what is free now and that the rest takes the three steps with a cooling-off', /in three steps/.test(mixed) && mixed.includes('Cooling-off') && mixed.includes('When it is back in your wallet, Kuza takes it off School fees'));
    check('take-out sheet, partly staked: the button goes on to the cooling-off, not "Take out"', (await text(t, '[data-rig=to-go]')) === 'Continue to the cooling-off');
    await t.shot(`${OUT}/p08-take-out-mixed.png`);
    await t.click('[data-rig=to-go]');
    await t.waitFor('[data-rig=wd-takeout]');
    const fromStake = 200 - Number(ready.replace(/,/g, ''));
    check(`withdraw sheet in take-out mode: ${fromStake} NIM pre-filled, the real steps, no "Break"`, (await t.eval(`document.querySelector('[data-rig=w-amount]').value`)) === String(fromStake)
      && (await text(t, '.sheet')).includes('Start cooling-off') && !(await text(t, '.sheet')).includes('Break') && (await text(t, '[data-rig=wd-takeout-note]')).includes('Kuza takes it off School fees'));
    await t.shot(`${OUT}/p09-take-out-cooling-sheet.png`);
    await t.click('[data-rig=w-submit]');
    await yes(t);
    await sleep(500);
    if ((await t.text()).includes('Pretend wallet')) await t.click('[data-rig=demo-yes]');
    await t.waitText('Cooling-off', 6000);
    await sleep(1200);
    let s = await state(t);
    goal = s.goals.find((g) => g.name === 'School fees');
    const outs = () => goal.entries.filter((e) => e.kind === 'out').map((e) => e.luna / NIM);
    check(`cooling-off started: the wallet part (${ready}) came off at once, the staked ${fromStake} not yet`, JSON.stringify(outs()) === JSON.stringify([20, Number(ready.replace(/,/g, ''))]) && s.unstake && s.unstake.takeOut === fromStake * NIM);
    check('cooling-off: the goal still counts the staked NIM (never pretends it is out already)', (await tile(t, 'In your stake')).includes('300 NIM'));
    await t.eval('window.__kuzaDemo.skipCooling()');
    await poke(t, 300);
    await t.waitText('Cooling-off finished', 6000);
    await t.click('[data-rig=cool-card]');
    await t.waitText('move to my wallet');
    await t.click('[data-rig=wd-release]');
    await yes(t);
    await sleep(1500);
    if ((await t.text()).includes('Pretend wallet')) await yes(t);
    await sleep(2000);
    await poke(t, 2500);
    s = await state(t);
    goal = s.goals.find((g) => g.name === 'School fees');
    const w = goal.entries.find((e) => e.kind === 'withdraw');
    check(`landed: withdraw ${fromStake} booked, then taken off the goal; the goal keeps ${300 - fromStake} staked, 0 set aside`, w && w.luna === fromStake * NIM && JSON.stringify(outs()) === JSON.stringify([20, Number(ready.replace(/,/g, '')), fromStake]) && !s.unstake
      && (await tile(t, 'In your stake')).includes(`${300 - fromStake} NIM`) && (await tile(t, 'Set aside')).includes(' 0 NIM'));
    check('the goal is still open (not deleted, not broken)', !goal.closedAt && (await t.has('[data-rig=save]')));
    await t.shot(`${OUT}/p10-after-stake-take-out.png`);

    // ---- The link in the other languages ----
    for (const [code, word] of [['es', 'Sacar una parte'], ['fr', 'En retirer une partie'], ['sw', 'Toa kiasi']]) {
      await t.go(`${base}?demo=1&lang=${code}#/goal/${goal.id}`, 1300);
      await demoUp(t);
      check(`${code}: "${word}" on the goal page, and its sheet opens`, (await text(t, '[data-rig=take-out]')) === word && (await t.click('[data-rig=take-out]'), await t.has('[data-rig=takeout-sheet]')));
      if (code === 'sw') await t.shot(`${OUT}/p11-sw-take-out.png`);
    }

    check('no horizontal scroll at 390 px', await t.noHScroll());
    check('no script errors or CSP violations', t.errors.length === 0 && t.csp.length === 0);
    if (t.errors.length || t.csp.length) console.log(t.errors, t.csp);
  } catch (e) {
    check(`drive ran to the end: ${String(e.message).split('\n')[0]}`, false);
    console.log(e.message.slice(0, 900));
  } finally {
    await chrome.stop();
    server.close();
  }
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed || checks.length < 25 ? 1 : 0);
}

main();
