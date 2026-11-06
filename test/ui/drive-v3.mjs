// The v3 flows at phone size: plan, milestones, rewards, sharing (message, link, QR read back with zbarimg), reaching a
// goal, using the money through a Lightning invoice, moving on to the next goal, the reopen wallet line, a friend's gift
// and thank-you, and the invite page in an ordinary Android, iPhone and computer browser.
// Usage: node test/ui/drive-v3.mjs <output dir>      (ports: KUZA_UI_PORT, KUZA_UI_CDP; another docs copy: KUZA_UI_ROOT)
import { mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { serve, startChrome, newTab, sleep } from './harness.mjs';

const OUT = resolve(process.argv[2] || 'tmp-ui-v3');
const SHOTS = `${OUT}/shots`;
const PORT = Number(process.env.KUZA_UI_PORT) || 8125;
const CDP = Number(process.env.KUZA_UI_CDP) || 9335;
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const OWNER = 'NQ49 DEMA 0000 0000 0000 0000 0000 0000 0001';
const BODY = 'pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq';

const checks = [];
const check = (name, ok) => { checks.push([name, Boolean(ok)]); console.log(ok ? 'ok  ' : 'FAIL', name); };
const decodeQR = (file) => {
  try { return execFileSync('zbarimg', ['--raw', '-q', '-Sbinary', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, ''); } catch { return ''; }
};
const capture = (t) => t.eval('(() => { window.__copied = null; navigator.clipboard.writeText = async (x) => { window.__copied = x; }; return true; })()');
const still = (t) => t.eval('window.__kuzaDemo.chain.noGrowth = true');
const state = (t) => t.eval(`JSON.parse(localStorage.getItem('kuza.demo.mainnet'))`);

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(SHOTS, { recursive: true });
  const server = await serve(PORT);
  const chrome = await startChrome(CDP, `${OUT}/profile`);
  const tabs = [];
  const tab = async (opts) => { const x = await newTab(CDP, opts); tabs.push(x); return x; };
  try {
    const base = `http://127.0.0.1:${PORT}/`;
    const t = await tab();

    // ---------- A. Saving with a monthly plan ----------
    await t.go(`${base}?demo=1&lang=en`);
    await t.eval('localStorage.clear()');
    await t.go(`${base}?demo=1&lang=en`);
    await still(t);
    await t.click('[data-rig=connect]');
    await t.waitText('Pretend wallet');
    await t.click('[data-rig=demo-yes]');
    await t.waitText('Your goals');
    await t.click('[data-rig=earned]');
    await t.waitText('Rewards start once you have a stake');
    check('rewards sheet: honest before any stake', true);
    await t.click('[data-rig=sheet-close]');
    await sleep(250);

    await t.click('[data-rig=new-goal]');
    await t.fill('[data-rig=f-name]', 'Laptop');
    await t.fill('[data-rig=f-target]', '400');
    await t.click('[data-rig=f-every-month]');
    check('form: month picked', await t.eval(`document.querySelector('[data-rig=f-every-month]').getAttribute('aria-checked') === 'true'`));
    await t.fill('[data-rig=f-date]', '2027-03-01');
    await sleep(120);
    check('form: monthly suggestion from the date', /a month for \d+ months/.test(await t.eval(`document.querySelector('[data-rig=f-hint]').textContent`)));
    await t.fill('[data-rig=f-weekly]', '100');
    await t.shot(`${SHOTS}/v3-01-new-goal-monthly.png`);
    await t.click('[data-rig=f-submit]');
    await t.waitText('Make your first saving');
    await t.fill('[data-rig=s-amount]', '150');
    await t.waitText('Stake 150 NIM');
    await t.click('[data-rig=s-submit]');
    await t.waitText('Pretend wallet');
    await t.click('[data-rig=demo-yes]');
    await t.waitText('Saved on-chain', 8000);
    await t.waitFor('[data-rig=plan-card]');
    const plan = await t.eval(`document.querySelector('[data-rig=plan-card]').innerText`);
    check('plan card: monthly plan, next saving, pace, streak', plan.includes('Plan: 100 NIM a month') && plan.includes('Done this month') && plan.includes('At this pace') && plan.includes('1 month in a row'));
    await t.waitFor('[data-rig=mark-banner]', 8000);
    check('25% moment shown on the goal', (await t.eval(`document.querySelector('[data-rig=mark-banner]').innerText`)).includes('A quarter of the way'));
    await t.shot(`${SHOTS}/v3-02-goal-plan-mark.png`);
    await t.click('[data-rig=goal-earned]');
    await t.waitText('No reward has arrived yet');
    check('rewards sheet: says nothing has arrived yet, and how it will', (await t.text()).includes('nothing to claim'));
    await t.click('[data-rig=sheet-close]');
    await sleep(250);
    await t.eval('location.hash = "#/"');
    await t.waitFor('[data-rig=next-line]');
    check('home card: this month done', (await t.eval(`document.querySelector('[data-rig=next-line]').innerText`)).includes("This month's saving is done"));

    // A reward lands in the stake.
    await t.eval('window.__kuzaDemo.reward(49500)');
    await t.eval('document.dispatchEvent(new Event("visibilitychange"))');
    await t.waitText('A staking reward arrived: +0.495 NIM', 8000);
    check('reward: toast with the amount', true);
    await t.waitText('last reward +0.495 NIM');
    check('reward: home shows the last reward and Earned', (await t.text()).includes('+0.495 NIM'));
    await t.shot(`${SHOTS}/v3-03-home-reward.png`);
    await t.click('[data-rig=earned]');
    await t.waitText('Reward added to your stake');
    check('rewards sheet: the event, the pool and how it works', (await t.text()).includes('Watched by this phone since'));
    await t.shot(`${SHOTS}/v3-04-rewards-sheet.png`);
    await t.click('[data-rig=sheet-close]');
    await sleep(250);

    // ---------- B. Sharing ----------
    await t.eval(`document.querySelector('.card.goal').click()`);
    await t.waitFor('[data-rig=invite-nudge]');
    check('goal: asks to invite friends before any gift', true);
    await t.click('[data-rig=share]');
    await t.waitFor('[data-rig=share-preview]');
    await capture(t);
    await t.click('[data-rig=share-copy-msg]');
    await sleep(300);
    const copied = await t.eval('window.__copied');
    const link = await t.eval(`document.querySelector('[data-rig=share-link]').value`);
    check('share: one tap copies message and short link', copied && copied.includes('Laptop') && copied.includes(link) && link.includes('?j=m') && link.length <= 140);
    await t.shot(`${SHOTS}/v3-05-share.png`);
    await t.click('[data-rig=share-qr]');
    await t.waitFor('[data-rig=qr] svg');
    await sleep(300);
    await t.shot(`${SHOTS}/v3-06-qr.png`);
    await t.shotOf('[data-rig=qr] svg', `${OUT}/qr-share.png`);
    check('QR on screen reads back as the invite link (zbarimg)', decodeQR(`${OUT}/qr-share.png`) === link);
    await t.click('[data-rig=sheet-close]');
    await sleep(250);
    check('after sharing, the invite nudge steps aside', !(await t.has('[data-rig=invite-nudge]')));

    // ---------- C. Reaching it, using it, moving on ----------
    await t.click('[data-rig=save]');
    await t.waitText('How much?');
    await t.fill('[data-rig=s-amount]', '250');
    await t.waitText('Stake 250 NIM');
    await t.click('[data-rig=s-submit]');
    await t.waitText('Pretend wallet');
    await t.click('[data-rig=demo-yes]');
    await t.waitFor('[data-rig=reached-sheet]', 10000);
    await sleep(700);
    const reached = await t.text();
    check('reached: celebration with what got it there', reached.includes('You reached Laptop!') && reached.includes('Saved') && reached.includes('Took') && reached.includes('Start the next goal'));
    await t.shot(`${SHOTS}/v3-07-reached.png`);
    await t.click('[data-rig=rs-use]');
    await t.waitFor('[data-rig=use-sheet]');
    check('use it: three honest steps', (await t.text()).includes('Stop earning') && (await t.text()).includes('Kuza never holds your NIM'));
    await t.shot(`${SHOTS}/v3-08-use.png`);
    await t.click('[data-rig=use-pay]');
    await t.waitFor('[data-rig=ln-sheet]');
    const lnMsg = () => t.eval(`document.querySelector('[data-rig=ln-msg]').textContent`);
    const lnOff = () => t.eval(`document.querySelector('[data-rig=ln-pay]').disabled`);
    await t.fill('[data-rig=ln-input]', 'hello');
    check('invoice: junk refused', (await lnMsg()).includes("doesn't look like") && (await lnOff()));
    await t.fill('[data-rig=ln-input]', `lntb2500u1${BODY}`);
    check('invoice: test network refused on mainnet', (await lnMsg()).includes('different network') && (await lnOff()));
    await t.fill('[data-rig=ln-input]', `lnbc1${BODY}`);
    check('invoice: no amount refused', (await lnMsg()).includes('no amount') && (await lnOff()));
    await t.fill('[data-rig=ln-input]', `lightning:LNBC2500U1${BODY.toUpperCase()}`);
    check('invoice: valid one accepted with its amount', (await lnMsg()).includes('250,000 sats') && !(await lnOff()));
    await t.shot(`${SHOTS}/v3-09-lightning.png`);
    await t.click('[data-rig=ln-pay]');
    await t.waitText('Pay with Bitcoin Lightning');
    await t.click('[data-rig=demo-yes]');
    await t.waitText('Payment submitted', 6000);
    await t.waitText('Paid a Lightning invoice · 250,000 sats', 6000);
    check('invoice: paid once, booked in the goal', (await t.eval('window.__kuzaDemo.chain.pays')) === 1);
    // The same invoice again: the wallet says duplicate, the button stays off.
    await t.click('[data-rig=r-use]');
    await t.waitFor('[data-rig=use-sheet]');
    await t.click('[data-rig=use-pay]');
    await t.waitFor('[data-rig=ln-sheet]');
    await t.fill('[data-rig=ln-input]', `lnbc2500u1${BODY}`);
    await t.eval(`window.__kuzaDemo.failNext('DUPLICATE_PAYMENT', undefined, 'This Lightning invoice was already submitted or may still be pending')`);
    await t.click('[data-rig=ln-pay]');
    await t.waitText('Pay with Bitcoin Lightning');
    await t.click('[data-rig=demo-yes]');
    await t.waitText("Don't pay it again", 6000);
    check('invoice: duplicate stops, never sent twice', (await lnOff()) && (await t.eval('window.__kuzaDemo.chain.pays')) === 1);
    await t.click('[data-rig=sheet-close]');
    await sleep(250);

    await t.click('[data-rig=r-next]');
    await t.waitText('Your next goal');
    check('next goal: offers to move the stake, ticked', (await t.eval(`document.querySelector('[data-rig=f-move]').checked`)) && (await t.text()).includes('Count the 400 NIM already in Laptop'));
    await t.fill('[data-rig=f-name]', 'Trip');
    await t.fill('[data-rig=f-target]', '2000');
    await t.shot(`${SHOTS}/v3-10-next-goal.png`);
    const stakeBefore = await t.eval('window.__kuzaDemo.chain.staker.balance');
    await t.click('[data-rig=f-submit]');
    await t.waitText('Moved from Laptop', 6000);
    const s1 = await state(t);
    const trip = s1.goals.find((g) => g.name === 'Trip');
    const laptop = s1.goals.find((g) => g.name === 'Laptop');
    check('next goal: stake counted, no transaction, old goal closed', trip.entries[0].kind === 'assign' && trip.entries[0].luna === 400e5 && laptop.closedAt > 0 && (await t.eval('window.__kuzaDemo.chain.staker.balance')) === stakeBefore);
    await t.shot(`${SHOTS}/v3-11-moved.png`);
    await t.eval('location.hash = "#/"');
    await t.waitFor('[data-rig=done-goals]');
    check('home: reached goals listed', (await t.eval(`document.querySelector('[data-rig=done-goals]').innerText`)).includes('Laptop'));
    await t.eval(`document.querySelector('[data-rig=done-goals]').scrollIntoView()`);
    await t.shot(`${SHOTS}/v3-12-home-done.png`);

    // ---------- D. Reopen: the wallet line without a Connect ----------
    await t.eval('location.reload()');
    await sleep(600);
    await still(t);
    let dialog = false;
    for (let i = 0; i < 40 && !(await t.has('[data-rig=wallet-nudge]')); i++) {
      if ((await t.text()).includes('Pretend wallet')) dialog = true;
      await sleep(150);
    }
    check('reopen: wallet line back from the stored accounts, no Connect asked', (await t.has('[data-rig=wallet-nudge]')) && !dialog && !(await t.text()).includes('Pretend wallet'));
    await t.shot(`${SHOTS}/v3-13-reopen-wallet-line.png`);
    await t.eval(`window.__kuzaDemo.emit('accountsChanged', ['${OWNER}', 'NQ22 DEMA 0000 0000 0000 0000 0000 0000 0002'])`);
    await sleep(300);
    check('wallet moved to a new account: list updated', (await state(t)).accounts.length === 2);
    await t.eval(`document.querySelector('.card.goal').click()`);
    await sleep(300);
    check('reopen: the goal says a Connect comes first', await t.has('[data-rig=connect-note]'));

    // ---------- E. A friend chips in (inside the pretend wallet) ----------
    const v = new URL(link).searchParams.get('j');
    await t.eval('localStorage.clear()');
    await t.go(`${base}?demo=1&lang=en&j=${v}`);
    await t.waitText('Add to this goal');
    check('friend: first-gift line', (await t.text()).includes('Be the first to chip in'));
    await t.fill('[data-rig=j-amount]', '100');
    await t.fill('[data-rig=j-note]', 'For the trip');
    await t.shot(`${SHOTS}/v3-14-friend.png`);
    await t.click('[data-rig=j-send]');
    await t.waitText('Connect to Kuza');
    await t.click('[data-rig=demo-yes]');
    await t.waitText('KZ1|');
    await t.click('[data-rig=demo-yes]');
    await t.waitFor('[data-rig=thanks]', 10000);
    await sleep(1200);
    const thanks = await t.text();
    check('thank-you: amount, progress, proof, start-your-own', thanks.includes('+100 NIM') && thanks.includes('of 400 NIM') && (await t.has('[data-rig=thanks-proof]')) && thanks.includes('Save for something of your own'));
    await t.shot(`${SHOTS}/v3-15-thanks.png`);
    await capture(t);
    await t.click('[data-rig=thanks-pass]');
    await sleep(250);
    const passed = await t.eval('window.__copied');
    check('thank-you: pass it on copies a message with the same goal', passed && passed.includes('chipped in') && passed.includes(`?j=${v}`));
    await t.eval(`document.querySelector('[data-rig=thanks-own] .ideas a').click()`);
    await sleep(1200);
    await t.waitFor('[data-rig=f-name]', 6000);
    check('thank-you: an idea opens the new goal form, filled in', (await t.eval(`document.querySelector('[data-rig=f-name]').value`)) === 'Emergency fund');
    await t.shot(`${SHOTS}/v3-16-friend-own-goal.png`);

    // ---------- F. The invite in an ordinary browser ----------
    const a = await tab({ ua: ANDROID });
    await a.go(`${base}?j=${v}`, 1500);
    await a.waitFor('[data-rig=invite]');
    const href = await a.eval(`document.querySelector('[data-rig=open-pay]').getAttribute('href')`);
    const inner = decodeURIComponent(href.slice('intent://miniapp?url='.length, href.indexOf('#')));
    check('android: no landing, the invite page shows', await a.eval(`!document.getElementById('landing') && document.documentElement.classList.contains('app')`));
    check('android: button = Nimiq Pay intent with Play Store fallback, opening this goal', href.startsWith('intent://miniapp?url=') && href.includes(';package=com.nimiq.pay;') && href.includes('S.browser_fallback_url=https%3A%2F%2Fplay.google.com') && inner === link);
    check('android: Play Store link, no App Store', (await a.has('[data-rig=store-android]')) && !(await a.has('[data-rig=store-ios]')));
    const other = await a.eval(`document.querySelector('[data-rig=inv-other]').textContent`);
    check('android: new-to-Nimiq-Pay steps and the any-wallet route', (await a.text()).includes('New to Nimiq Pay?') && other.includes(OWNER) && other.includes('KZ1|'));
    check('android: no horizontal scroll', await a.noHScroll());
    await a.shot(`${SHOTS}/v3-17-invite-android.png`);
    await a.eval(`document.querySelector('[data-rig=inv-new]').scrollIntoView()`);
    await a.shot(`${SHOTS}/v3-18-invite-android-steps.png`);
    check('android: no CSP violations', a.csp.length === 0);

    const i = await tab({ ua: IPHONE });
    await i.go(`${base}?j=${v}`, 1500);
    await i.waitFor('[data-rig=invite]');
    const ihref = await i.eval(`document.querySelector('[data-rig=open-pay]').getAttribute('href')`);
    check('iphone: button = nimiqpay:// link to this goal, App Store offered', ihref === `nimiqpay://miniapp?url=${encodeURIComponent(link)}` && (await i.has('[data-rig=store-ios]')) && !(await i.has('[data-rig=store-android]')));
    await i.eval(`document.querySelector('[data-rig=open-pay]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))`);
    await sleep(3200);
    check('iphone: nothing opened -> the get-the-app help shows', await i.eval(`!document.querySelector('[data-rig=inv-noapp]').hidden`));
    await i.shot(`${SHOTS}/v3-19-invite-iphone-noapp.png`);

    const d = await tab({ width: 1280, height: 800, ua: DESKTOP });
    await d.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await d.go(`${base}?j=${v}`, 1500);
    await d.waitFor('[data-rig=invite]');
    await d.click('[data-rig=open-pay]');
    await d.waitFor('[data-rig=qr] svg');
    await sleep(300);
    await d.shotOf('[data-rig=qr] svg', `${OUT}/qr-desktop.png`);
    check('computer: the button shows a QR of this goal (zbarimg)', decodeQR(`${OUT}/qr-desktop.png`) === link);
    await d.shot(`${SHOTS}/v3-20-invite-desktop-qr.png`);

    // ---------- G. Longest languages at small widths ----------
    const f = await tab({ width: 360, height: 760, ua: ANDROID, lang: 'fr-FR,fr' });
    await f.go(`${base}?j=${v}`, 1500);
    await f.waitFor('[data-rig=invite]');
    check('fr 360 px: invite page in French, no horizontal scroll', (await f.text()).includes('Participer avec Nimiq Pay') && (await f.noHScroll()));
    await f.shot(`${SHOTS}/v3-21-invite-fr-360.png`);
    const w = await tab({ width: 360, height: 760 });
    await w.go(`${base}?demo=1&lang=sw`);
    await w.eval('localStorage.clear()');
    await w.go(`${base}?demo=1&lang=sw`);
    await still(w);
    await w.click('[data-rig=connect]');
    await w.waitText('Pretend wallet');
    await w.click('[data-rig=demo-yes]');
    await w.waitFor('[data-rig=new-goal]');
    await w.click('[data-rig=new-goal]');
    await w.fill('[data-rig=f-name]', 'Ada ya shule');
    await w.fill('[data-rig=f-target]', '3000');
    await w.fill('[data-rig=f-weekly]', '150');
    check('sw 360 px: goal form with the plan, no horizontal scroll', await w.noHScroll());
    await w.shot(`${SHOTS}/v3-22-sw-form-360.png`);
    await w.click('[data-rig=f-submit]');
    await w.waitFor('[data-rig=s-amount]');
    await w.click('[data-rig=sheet-close]');
    await sleep(300);
    await w.click('[data-rig=share]');
    await w.waitFor('[data-rig=share-preview]');
    check('sw 360 px: share sheet fits', (await w.noHScroll()) && (await w.eval(`document.querySelector('.sheet').scrollWidth <= document.querySelector('.sheet').clientWidth + 1`)));
    await w.shot(`${SHOTS}/v3-23-sw-share-360.png`);

    const errors = tabs.flatMap((x) => x.errors);
    const csp = tabs.flatMap((x) => x.csp);
    check('no script errors', errors.length === 0);
    check('no CSP violations in any tab', csp.length === 0);
    if (errors.length || csp.length) console.log([...errors, ...csp].slice(0, 8).join('\n'));
  } catch (err) {
    console.log('FAIL', err.message);
    checks.push(['run', false]);
  } finally {
    await chrome.stop();
    server.close();
  }
  const failed = checks.filter(([, ok]) => !ok);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length || checks.length < 40 ? 1 : 0);
}

main();
