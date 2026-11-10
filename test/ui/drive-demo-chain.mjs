// The browser demo keeps its pretend chain across a reload: stake 10,000 of the pretend 25,000 NIM, reload, and the
// wallet still has 15,000 while the stake is still 10,000, so the same 25,000 can't be staked twice. Settings > Reset
// demo clears the chain and the demo's goals together; a damaged saved chain is ignored and rebuilt from what the goals
// booked (a fresh chain when they booked no stake). The chain is kept beside the goals (localStorage, since 10 Nov),
// and an older per-tab copy (sessionStorage) is carried over once.
// Usage: node test/ui/drive-demo-chain.mjs <output dir>   (ports: KUZA_UI_PORT, KUZA_UI_CDP; another docs copy: KUZA_UI_ROOT)
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serve, startChrome, newTab, sleep } from './harness.mjs';
import { ln } from '../fixtures/lightning.mjs';

const OUT = resolve(process.argv[2] || 'tmp-ui-demo-chain');
const PORT = Number(process.env.KUZA_UI_PORT) || 8127;
const CDP = Number(process.env.KUZA_UI_CDP) || 9337;
const NIM = 1e5;

const checks = [];
const check = (name, ok) => { checks.push([name, Boolean(ok)]); console.log(ok ? 'ok  ' : 'FAIL', name); };
const demoUp = async (t) => {
  for (let i = 0; i < 80 && !(await t.eval('!!window.__kuzaDemo')); i++) await sleep(100); // the demo loads after boot
  return t.eval('!!window.__kuzaDemo');
};
const chain = (t) => t.eval(`(() => { const c = window.__kuzaDemo.chain; return { wallet: c.wallet, stake: c.staker ? c.staker.balance : null, txs: c.history.length, inTxs: c.txs.size, height: c.height }; })()`);
const demoKeys = (t) => t.eval(`Object.keys(localStorage).filter((k) => k.startsWith('kuza.demo.')).length + (localStorage.getItem('kuza.demo.chain') ? 100 : 0)`);

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const server = await serve(PORT);
  const chrome = await startChrome(CDP, `${OUT}/profile`);
  let t = null;
  try {
    const base = `http://127.0.0.1:${PORT}/`;
    t = await newTab(CDP);

    // Outside the demo nothing is written for the pretend chain.
    await t.go(base);
    check('no demo: no pretend chain saved', !(await t.eval(`!!(localStorage.getItem('kuza.demo.chain') || sessionStorage.getItem('kuza.demo.chain'))`)));

    await t.go(`${base}?demo=1&lang=en`);
    await t.eval('localStorage.clear(); sessionStorage.clear()');
    await t.go(`${base}?demo=1&lang=en`);
    check('demo loaded', await demoUp(t));
    await t.eval('window.__kuzaDemo.chain.noGrowth = true');
    await t.click('[data-rig=connect]');
    await t.waitText('Pretend wallet');
    await t.click('[data-rig=demo-yes]');
    await t.waitText('25,000 NIM in your wallet');

    // A goal and a 10,000 NIM stake.
    await t.click('[data-rig=new-goal]');
    await t.fill('[data-rig=f-name]', 'Bike');
    await t.fill('[data-rig=f-target]', '20000');
    await t.click('[data-rig=f-submit]');
    await t.waitText('Make your first saving');
    await t.fill('[data-rig=s-amount]', '10000');
    await t.waitText('Stake 10,000 NIM');
    await t.click('[data-rig=s-submit]');
    await t.waitText('Pretend wallet');
    await t.click('[data-rig=demo-yes]');
    await t.waitText('Saved on-chain', 8000);
    const before = await chain(t);
    check(`stake: pretend wallet 15,000 and stake 10,000 before the reload (${before.wallet / NIM} / ${before.stake / NIM})`, before.wallet === 15000 * NIM && before.stake === 10000 * NIM && before.txs === 1);

    // Reload: the chain is the same one.
    await t.eval('location.reload()');
    await sleep(900);
    check('reload: demo back', await demoUp(t));
    await t.eval('window.__kuzaDemo.chain.noGrowth = true');
    const after = await chain(t);
    check(`reload: pretend wallet still 15,000 NIM (${after.wallet / NIM})`, after.wallet === 15000 * NIM);
    check(`reload: stake still 10,000 NIM (${after.stake === null ? 'none' : after.stake / NIM})`, after.stake !== null && after.stake >= 10000 * NIM && after.stake < 10000 * NIM + 1000);
    check('reload: the staking transaction is still on the pretend chain and can be looked up', after.txs === 1 && after.inTxs === 1);
    check('reload: block height did not go back', after.height >= before.height);

    // The save sheet reads the same wallet and refuses to stake the 25,000 again.
    await t.waitText('Bike');
    await t.eval(`document.querySelector('.card.goal')?.click()`);
    await sleep(400);
    await t.click('[data-rig=save]');
    await sleep(400);
    if ((await t.text()).includes('Connect to Kuza')) await t.click('[data-rig=demo-yes]');
    await t.waitText('How much?');
    await t.waitText('In your wallet: 15,000 NIM', 6000);
    check('save sheet: wallet reads 15,000 NIM after the reload', true);
    await t.fill('[data-rig=s-amount]', '25000');
    await sleep(300);
    const sheet = await t.text();
    check('save sheet: 25,000 NIM again is refused (more than the wallet)', sheet.includes('You have 15,000 NIM in your wallet'));
    await t.shot(`${OUT}/demo-after-reload.png`);
    await t.click('[data-rig=sheet-close]');
    await sleep(300);

    // Reset demo: the first tap only asks, the second clears the chain and the goals together.
    await t.eval('location.hash = "#/"');
    await sleep(300);
    await t.click('[data-rig=settings]');
    await t.waitFor('[data-rig=demo-reset]');
    await t.click('[data-rig=demo-reset]');
    await t.waitText('Tap again to clear the demo goals and pretend wallet');
    check('reset: first tap only asks', (await demoKeys(t)) > 100 && (await t.eval(`window.__kuzaDemo.chain.wallet`)) === 15000 * NIM);
    await t.shot(`${OUT}/demo-reset-armed.png`);
    await t.click('[data-rig=demo-reset]');
    await sleep(1200);
    check('reset: demo back', await demoUp(t));
    await t.waitText('Save toward something real');
    const fresh = await chain(t);
    check(`reset: pretend wallet 25,000 NIM, no stake, no history (${fresh.wallet / NIM} / ${fresh.stake} / ${fresh.txs})`, fresh.wallet === 25000 * NIM && fresh.stake === null && fresh.txs === 0);
    check('reset: no demo goals left', !(await t.eval(`(JSON.parse(localStorage.getItem('kuza.demo.mainnet') || 'null')?.goals || []).length`)));

    // Savings set aside in the wallet (no stake): "Use the money" says they can be spent now, no three steps; a Lightning
    // payment then comes off what the goal holds.
    await t.waitFor('[data-rig=connect]');
    await t.click('[data-rig=connect]');
    await t.waitText('Pretend wallet');
    await t.click('[data-rig=demo-yes]');
    await t.waitFor('[data-rig=new-goal]');
    await t.click('[data-rig=new-goal]');
    await t.fill('[data-rig=f-name]', 'Lightning test');
    await t.fill('[data-rig=f-target]', '70');
    await t.click('[data-rig=f-submit]');
    await t.waitText('Make your first saving');
    await t.fill('[data-rig=s-amount]', '70');
    await t.waitText('under the network');
    await t.click('[data-rig=s-submit]');
    await t.waitText('stays in your wallet');
    for (let i = 0; i < 30 && !(await t.has('[data-rig=rs-use]')) && !(await t.has('[data-rig=r-use]')); i++) await sleep(200);
    await t.click((await t.has('[data-rig=rs-use]')) ? '[data-rig=rs-use]' : '[data-rig=r-use]');
    await t.waitFor('[data-rig=use-sheet]');
    const use = await t.eval(`document.querySelector('[data-rig=use-intro]').innerText`);
    check(`use the money, wallet-held goal: "spend it right away", no stake steps (${use})`, use.includes('70 NIM is set aside in your own wallet') && !(await t.has('[data-rig=use-sheet] .steps')) && !use.includes('in your own stake'));
    await t.shot(`${OUT}/use-wallet-only.png`);
    await t.click('[data-rig=use-pay]');
    await t.waitFor('[data-rig=ln-sheet]');
    await t.fill('[data-rig=ln-input]', ln('lnbc300n'));
    await t.waitText('30 sats');
    await t.click('[data-rig=ln-pay]');
    await t.waitText('Pay with Bitcoin Lightning');
    await t.click('[data-rig=demo-yes]');
    await t.waitText('Payment submitted', 6000);
    let left = null;
    for (let i = 0; i < 40; i++) {
      left = await t.eval(`(() => { const s = JSON.parse(localStorage.getItem('kuza.demo.mainnet')); const g = s.goals.find((x) => x.name === 'Lightning test');
        const sp = g.entries.find((e) => e.kind === 'spend'); return sp && sp.luna ? document.body.innerText : null; })()`);
      if (left) break;
      await sleep(250);
    }
    check('after the payment the goal no longer shows the 70 NIM as set aside', !!left && /Set aside\s*\n?\s*0 NIM/.test(left) && !/Set aside\s*\n?\s*70 NIM/.test(left));
    await t.shot(`${OUT}/after-lightning.png`);

    // A damaged saved chain is ignored as a whole: the demo rebuilds it from the goals instead of failing.
    const bad = [
      '{not json',
      JSON.stringify({ v: 1, height: 65800000, wallet: -5, staker: null, history: [] }),
      JSON.stringify({ v: 1, height: 65800000, wallet: 1e5, staker: { balance: '1e99' }, history: [] }),
      JSON.stringify({ v: 1, height: 65800000, wallet: 1e5, staker: null, history: [{ hash: 'zz' }] }),
      JSON.stringify({ v: 1, height: 65800000, wallet: 1e5, staker: null, history: [], pad: 'x'.repeat(300 * 1024) }),
    ];
    // The page saves its chain as it unloads, so the damaged copy is put in place as the next page starts, before the app.
    // What the goals booked in the stake right now: the rebuilt chain must hold exactly that (none: a fresh chain).
    const booked = await t.eval(`import('./js/goals.js').then((G) => G.totalPrincipal(JSON.parse(localStorage.getItem('kuza.demo.mainnet')).goals))`);
    const MIN = (await import('../../docs/js/staking.js')).MIN_STAKE;
    console.log('booked in the stake before the damaged copies:', booked / NIM);
    const rebuilt = (c) => (booked >= MIN ? c.stake === booked && c.wallet === 25000 * NIM - booked && c.txs === 1 : c.wallet === 25000 * NIM && c.stake === null && c.txs === 0);
    let fine = 0;
    for (const raw of bad) {
      const { identifier } = await t.call('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('kuza.demo.chain', ${JSON.stringify(raw)}); sessionStorage.removeItem('kuza.demo.chain')` });
      await t.eval('location.reload()');
      await sleep(700);
      await t.call('Page.removeScriptToEvaluateOnNewDocument', { identifier });
      if (!(await demoUp(t))) continue;
      const c = await chain(t);
      if (rebuilt(c)) fine++;
      else console.log('damaged copy gave', JSON.stringify(c));
    }
    check(`damaged saved chain: ignored, rebuilt from the goals (${booked / NIM} NIM booked in the stake) (${fine}/${bad.length})`, fine === bad.length);

    // An older version's per-tab copy (sessionStorage) is carried over once when there is no shared copy yet.
    const old = JSON.stringify({ v: 1, height: 65900000, wallet: 1234 * NIM, staker: null, history: [] });
    const { identifier: oldId } = await t.call('Page.addScriptToEvaluateOnNewDocument', { source: `if (!sessionStorage.getItem('test.once')) { sessionStorage.setItem('test.once', '1'); localStorage.removeItem('kuza.demo.chain'); sessionStorage.setItem('kuza.demo.chain', ${JSON.stringify(old)}); }` });
    await t.eval('sessionStorage.removeItem("test.once")');
    await t.eval('location.reload()');
    await sleep(700);
    await t.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: oldId });
    await demoUp(t);
    const carried = await chain(t);
    check('older per-tab copy: carried over (wallet 1,234 NIM), moved to the shared copy, the tab copy gone', carried.wallet === 1234 * NIM
      && (await t.eval(`JSON.parse(localStorage.getItem('kuza.demo.chain')).wallet`)) === 1234 * NIM && !(await t.eval(`sessionStorage.getItem('kuza.demo.chain')`)));
  } finally {
    await chrome.stop();
    server.close();
  }
  const failed = checks.filter(([, ok]) => !ok);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  if (!checks.length || failed.length) process.exit(1);
}

main().catch((err) => { console.error('FAIL', err.message.slice(0, 900)); process.exit(1); });
