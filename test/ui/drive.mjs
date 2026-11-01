// Drives the app in the demo with a private headless Chrome and a phone-sized viewport.
// Usage: node test/ui/drive.mjs <output dir>
// Standard library only. Uses its own Chrome profile and port, so it can't touch any other browser.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const OUT = resolve(process.argv[2] || 'tmp-ui');
const ROOT = resolve(new URL('../../docs', import.meta.url).pathname);
const PORT = 8123;
const CDP = 9333;
const PROFILE = `${OUT}/profile`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = join(ROOT, path.endsWith('/') ? `${path}index.html` : path);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 0;

class Tab {
  constructor(ws) { this.ws = ws; this.waiting = new Map(); this.errors = []; ws.onmessage = (e) => this.onMessage(JSON.parse(e.data)); }
  onMessage(m) {
    if (m.id && this.waiting.has(m.id)) { this.waiting.get(m.id)(m); this.waiting.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon|ERR_NAME|Failed to load|workers.dev|nimiqwatch/.test(m.params.entry.text + m.params.entry.url)) this.errors.push(m.params.entry.text + ' ' + (m.params.entry.url || ''));
  }
  call(method, params = {}) {
    const i = ++id;
    return new Promise((res, rej) => { this.waiting.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))); this.ws.send(JSON.stringify({ id: i, method, params })); });
  }
  async eval(expr) {
    const r = await this.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result.value;
  }
  async go(url) { await this.call('Page.navigate', { url }); await sleep(900); }
  async shot(path) { const r = await this.call('Page.captureScreenshot', { format: 'png' }); await writeFile(path, Buffer.from(r.data, 'base64')); }
  async click(sel) {
    const ok = await this.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true})()`);
    if (!ok) throw new Error(`no element ${sel}: ` + (await this.text()).slice(0, 300));
    await sleep(160);
  }
  async fill(sel, value) {
    const ok = await this.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    if (!ok) throw new Error(`no field ${sel}`);
    await sleep(60);
  }
  text() { return this.eval('document.body.innerText'); }
  async waitText(needle, ms = 6000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if ((await this.text()).includes(needle)) return;
      await sleep(100);
    }
    throw new Error(`text not found: ${needle}\n--- page ---\n${(await this.text()).slice(0, 800)}`);
  }
  /** After a reload the wallet list is asked for again, once. */
  async openSave() {
    await this.click('[data-rig=save]');
    await sleep(400);
    if ((await this.text()).includes('Connect to Kuza')) await this.click('[data-rig=demo-yes]');
    await this.waitText('How much?');
  }
  async noHScroll() { return this.eval('document.documentElement.scrollWidth <= window.innerWidth'); }
}

const checks = [];
const check = (name, ok) => { checks.push([name, ok]); console.log(ok ? 'ok  ' : 'FAIL', name); };

async function newTab(width = 390, height = 844) {
  const res = await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' });
  const info = await res.json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  const tab = new Tab(ws);
  await tab.call('Page.enable');
  await tab.call('Runtime.enable');
  await tab.call('Log.enable');
  await tab.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
  return tab;
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://127.0.0.1:${CDP}/json/version`); break; } catch { await sleep(200); }
    }
    const base = `http://127.0.0.1:${PORT}/`;
    const t = await newTab();

    // Outside Nimiq Pay.
    await t.go(base);
    await t.waitText('Open in Nimiq Pay');
    check('outside: landing shows', true);
    await t.shot(`${OUT}/00-outside.png`);

    // First run.
    await t.go(`${base}?demo=1&lang=en`);
    await t.waitText('Save toward something real');
    await t.shot(`${OUT}/01-welcome.png`);
    check('welcome: no horizontal scroll', await t.noHScroll());

    // Cancelling connect leaves the screen usable.
    await t.click('[data-rig=connect]');
    await t.waitText('Pretend wallet');
    await t.click('[data-rig=demo-no]');
    await t.waitText('Connect when you');
    check('connect: reject keeps the screen usable', (await t.text()).includes('Connect wallet'));

    await t.click('[data-rig=connect]');
    await t.waitText('Pretend wallet');
    await t.click('[data-rig=demo-yes]');
    await t.waitText('Your goals');
    await t.shot(`${OUT}/02-home-empty.png`);
    check('home after connect', true);

    // New goal: bad input first.
    await t.click('[data-rig=new-goal]');
    await t.fill('[data-rig=f-name]', '');
    await t.click('[data-rig=f-submit]');
    await t.waitText('Give your goal a name');
    await t.fill('[data-rig=f-name]', 'New motorbike <b>x</b>');
    await t.fill('[data-rig=f-target]', 'abc');
    await t.click('[data-rig=f-submit]');
    await t.waitText('Set a target');
    await t.fill('[data-rig=f-target]', '5000');
    await t.fill('[data-rig=f-date]', '2027-03-01');
    await sleep(100);
    await t.shot(`${OUT}/03-new-goal.png`);
    check('form: weekly plan suggested', Number(await t.eval(`document.querySelector('[data-rig=f-weekly]').value`)) > 0);
    await t.fill('[data-rig=f-weekly]', '50');
    await t.click('[data-rig=f-submit]');
    await t.waitText('Make your first saving');

    // Under the minimum: stays in the wallet.
    await t.fill('[data-rig=s-amount]', '60');
    await t.waitText('under the network');
    await t.shot(`${OUT}/04-save-aside.png`);
    await t.click('[data-rig=s-submit]');
    await t.waitText('stays in your wallet');
    await t.waitText('Set aside in wallet');
    check('save: under 100 NIM set aside with no transaction', (await t.eval('window.__kuzaDemo.chain.staker')) === null);
    check('goal name is text, not markup', !(await t.eval('!!document.querySelector("main b b, .goal-hero h1 b")')));

    // Move what's set aside, plus more, into a new stake. Reject first.
    await t.openSave();
    await t.fill('[data-rig=s-amount]', '100');
    await t.waitText('Include the 60 NIM');
    await t.eval(`document.querySelector('[data-rig=s-wallet]').click()`);
    await t.waitText('Stake 160 NIM');
    await t.shot(`${OUT}/05-save-stake.png`);
    const before = await t.eval(`document.querySelector('[data-rig=s-pool] b').textContent`);
    await t.click('[data-rig=s-pool]');
    await t.waitText('Choose a pool');
    await t.eval(`document.querySelectorAll('.sheet .pool')[1].click()`);
    await t.waitText('Stake 160 NIM');
    const after = await t.eval(`document.querySelector('[data-rig=s-pool] b').textContent`);
    check('pool choice sticks and the amount is kept', before !== after);
    await t.click('[data-rig=s-submit]');
    await t.waitText('Pretend wallet');
    await t.click('[data-rig=demo-no]');
    await t.waitText('Nothing was sent');
    check('stake: cancel leaves the sheet usable', await t.eval(`!document.querySelector('[data-rig=s-submit]').disabled`));
    await t.click('[data-rig=s-submit]');
    await t.waitText('Pretend wallet');
    await t.click('[data-rig=demo-yes]');
    await t.waitText('Saved on-chain', 8000);
    await t.waitText('Staked');
    const staker = await t.eval('window.__kuzaDemo.chain.staker');
    check('stake: 160 NIM reached the (pretend) staker', staker && staker.balance >= 160e5);
    await t.shot(`${OUT}/06-goal.png`);

    // Unknown outcome: recorded as pending, never retried, settled from the chain.
    await t.openSave();
    await t.fill('[data-rig=s-amount]', '10');
    await t.waitText('Stake 10 NIM');
    await t.eval(`window.__kuzaDemo.failNext('TRANSACTION_OUTCOME_UNKNOWN', -32001, 'outcome unknown', {})`);
    await t.click('[data-rig=s-submit]');
    await t.waitText('Pretend wallet');
    await t.click('[data-rig=demo-yes]');
    await t.waitText('Don\'t send it again');
    check('unknown outcome: shown as confirming, sheet closed', (await t.text()).includes('confirming') && !(await t.eval(`!!document.querySelector('[data-rig=s-submit]')`)));
    await t.click('[data-rig=save]');
    await t.waitText('still confirming');
    check('unknown outcome: no second send while it is open', !(await t.eval(`!!document.querySelector('[data-rig=s-submit]')`)));
    await t.eval(`(() => { const k = 'kuza.v1.mainnet'; const s = JSON.parse(localStorage.getItem(k)); for (const g of s.goals) g.entries = g.entries.filter((e) => e.status !== 'pending'); localStorage.setItem(k, JSON.stringify(s)); })()`);
    await t.eval('location.reload()');
    await sleep(1400);
    await t.waitText('New motorbike');
    await t.eval(`window.__kuzaDemo = window.__kuzaDemo`);
    await t.eval(`document.querySelector('.card.goal')?.click()`);
    await sleep(300);

    // The reload reset the pretend chain, so the wallet has no stake while the goal remembers one.
    await t.eval(`window.__kuzaDemo.chain.staker = { balance: 160e5, inactiveBalance: 0, retiredBalance: 0, inactiveFrom: null, delegation: 'NQ15 HNAH YRVH DFVM YHAG BSXG 0QHK KA0Q XDR7' }`);
    await t.eval('document.dispatchEvent(new Event("visibilitychange"))');
    await sleep(500);

    // Wallet still busy with an earlier transaction: says so and keeps the sheet.
    await t.openSave();
    await t.fill('[data-rig=s-amount]', '5');
    await t.waitText('Stake 5 NIM');
    await t.eval(`window.__kuzaDemo.failNext('INTERNAL_ERROR', -32603, 'Failed to send payment transaction: A transaction is still pending. Wait for it to resolve before sending another.')`);
    await t.click('[data-rig=s-submit]');
    await t.waitText('Pretend wallet');
    await t.click('[data-rig=demo-yes]');
    await t.waitText('still finishing an earlier transaction');
    check('wallet busy: friendly message, sheet stays', await t.eval(`!!document.querySelector('[data-rig=s-submit]')`));
    await t.click('[data-rig=sheet-close]');

    // Top-up under 100 NIM once a stake exists.
    await t.openSave();
    await t.fill('[data-rig=s-amount]', '25');
    await t.waitText('Stake 25 NIM');
    await t.click('[data-rig=s-submit]');
    await t.waitText('Pretend wallet');
    await t.click('[data-rig=demo-yes]');
    await t.waitText('Saved on-chain', 8000);
    check('stake: top-up under 100 NIM goes to add-stake', (await t.eval('window.__kuzaDemo.chain.staker.balance')) >= 185e5);
    await t.eval('location.reload()');
    await sleep(1400);
    await t.waitText('New motorbike');
    await t.eval(`document.querySelector('.card.goal')?.click()`);
    await sleep(300);
    await t.eval(`window.__kuzaDemo.chain.staker = { balance: 185e5, inactiveBalance: 0, retiredBalance: 0, inactiveFrom: null, delegation: 'NQ15 HNAH YRVH DFVM YHAG BSXG 0QHK KA0Q XDR7' }`);
    await t.eval('document.dispatchEvent(new Event("visibilitychange"))');
    await sleep(500);

    // A gift from someone else shows up from the chain. Refresh by reloading the screen state.
    const gid = await t.eval(`location.hash.split('/').pop()`);
    await t.eval(`window.__kuzaDemo.gift(4200000, 'KZ1|${gid}|For the bike!')`);

    // Share link and the jar page.
    await t.click('[data-rig=share]');
    await t.waitText('Your invite link');
    await t.shot(`${OUT}/07-share.png`);
    const link = await t.eval(`document.querySelector('[data-rig=share-link]').value`);
    check('share: link is on the public URL', link.startsWith('https://swiftbotlab.github.io/kuza/?jar='));
    await t.click('[data-rig=sheet-close]');

    // Break the goal: dust rule first.
    await t.click('[data-rig=break]');
    await t.waitText('Leaving takes time');
    await t.shot(`${OUT}/08-break.png`);
    await t.fill('[data-rig=w-amount]', '100');
    await t.waitText('at least 100 NIM to stay staked');
    check('break: dust is refused', await t.eval(`document.querySelector('[data-rig=w-submit]').disabled`));
    await t.fill('[data-rig=w-amount]', '999999');
    await t.waitText('Your stake has');
    await t.fill('[data-rig=w-amount]', '180');
    await t.waitText('Take out all');
    await t.eval(`[...document.querySelectorAll('.chip-btn')].find((b) => b.textContent.startsWith('Take out all')).click()`);
    await sleep(100);
    check('break: full amount allowed', !(await t.eval(`document.querySelector('[data-rig=w-submit]').disabled`)));
    await t.click('[data-rig=w-submit]');
    await t.waitText('Pretend wallet');
    await t.click('[data-rig=demo-yes]');
    await t.waitText('Cooling-off', 6000);
    await sleep(300);
    await t.click('[data-rig=cool-card]');
    await t.waitText('left, until around');
    await t.shot(`${OUT}/09-cooling.png`);
    await t.click('[data-rig=sheet-close]');

    // Wait out the pretend cooling-off, then retire and remove.
    await t.eval('window.__kuzaDemo.skipCooling()');
    await t.eval('document.dispatchEvent(new Event("visibilitychange"))');
    await t.waitText('Cooling-off finished', 5000);
    await t.click('[data-rig=cool-card]');
    await t.waitText('Finish: move to my wallet');
    await t.click('[data-rig=wd-release]');
    await t.waitText('Pretend wallet');
    await t.click('[data-rig=demo-yes]');
    await sleep(1500);
    await t.waitText('Pretend wallet', 8000);
    await t.click('[data-rig=demo-yes]');
    await t.waitText('Back in your wallet', 8000);
    check('break: stake fully removed', (await t.eval('window.__kuzaDemo.chain.staker')) === null);
    await sleep(500);
    await t.waitText('Withdrawn');
    await t.shot(`${OUT}/10-after-break.png`);

    // A stale view must not send create-staker to a wallet that already has a stake.
    await t.go(`${base}?demo=1&lang=en`);
    await sleep(600);
    await t.waitText('New motorbike');
    await t.eval(`document.querySelector('.card.goal')?.click()`);
    await sleep(300);
    await t.openSave();
    await t.fill('[data-rig=s-amount]', '150');
    await t.waitText('This starts your stake');
    await t.eval(`window.__kuzaDemo.chain.staker = { balance: 150e5, inactiveBalance: 0, retiredBalance: 0, inactiveFrom: null, delegation: 'NQ15 HNAH YRVH DFVM YHAG BSXG 0QHK KA0Q XDR7' }`);
    await t.click('[data-rig=s-submit]');
    await t.waitText('Add Stake');
    await t.click('[data-rig=demo-no]');
    await t.waitText('Nothing was sent');
    check('stale view: sends add-stake, not create-staker', !(await t.eval('window.__kuzaDemo.chain.creates')));
    await t.click('[data-rig=sheet-close]');

    // The network going away never leaves a blank screen.
    await t.eval('window.__kuzaDemo.chain.offline = true');
    await t.eval('document.dispatchEvent(new Event("visibilitychange"))');
    await t.waitText('reach the network');
    check('offline: banner, screen stays', (await t.text()).includes('New motorbike'));
    await t.shot(`${OUT}/10b-offline.png`);
    await t.eval('window.__kuzaDemo.chain.offline = false');

    // Reload keeps goals.
    await t.eval('location.reload()');
    await sleep(1200);
    await t.waitText('New motorbike');
    check('reload: goal survives in storage', true);

    // How it works, languages, overflow in each.
    for (const code of ['en', 'es', 'fr', 'sw']) {
      await t.go(`${base}?demo=1&lang=${code}`);
      await sleep(500);
      const home = await t.noHScroll();
      await t.eval('location.hash="#/how"');
      await sleep(250);
      await t.shot(`${OUT}/11-how-${code}.png`);
      check(`${code}: no horizontal scroll`, home && (await t.noHScroll()));
      await t.eval('location.hash="#/"');
      await sleep(100);
    }

    // Jar page with hostile link values and a real payment.
    await t.go(`${base}?demo=1&lang=en&jar=not-a-real-link`);
    await sleep(500);
    check('jar: bad link falls back, not blank', (await t.text()).length > 40);
    await t.eval('localStorage.clear()');
    const jar = link.split('jar=')[1];
    await t.go(`${base}?demo=1&lang=en&jar=${jar}`);
    await t.waitText('Add to this goal');
    await t.fill('[data-rig=j-amount]', '100');
    await t.fill('[data-rig=j-note]', 'Happy birthday');
    await t.shot(`${OUT}/12-jar.png`);
    await t.click('[data-rig=j-send]');
    await t.waitText('Connect to Kuza');
    await t.click('[data-rig=demo-yes]');
    await t.waitText('KZ1|');
    await t.shot(`${OUT}/13-jar-sheet.png`);
    await t.click('[data-rig=demo-yes]');
    await t.waitText('Thank you', 8000);
    check('jar: gift sent with memo', (await t.eval(`window.__kuzaDemo.chain.history[0].recipientData.length`)) > 20);

    // Small phone.
    const s = await newTab(320, 640);
    await s.go(`${base}?demo=1&lang=sw`);
    await sleep(600);
    check('320 px: no horizontal scroll', await s.noHScroll());
    await s.shot(`${OUT}/14-small.png`);

    check('no script errors', t.errors.length === 0 && s.errors.length === 0);
    if (t.errors.length || s.errors.length) console.log([...t.errors, ...s.errors].slice(0, 8).join('\n'));
  } catch (err) {
    console.log('FAIL', err.message);
    checks.push(['run', false]);
  } finally {
    chrome.kill('SIGTERM');
    server.close();
    await sleep(300);
    await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
  }
  const failed = checks.filter(([, ok]) => !ok);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main();
