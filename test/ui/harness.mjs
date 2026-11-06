// Shared pieces for the UI checks: a static server for docs/, a private headless Chrome, and a small tab driver.
// Standard library only. Chrome gets its own profile and debug port, and refuses to start if that port is taken,
// so these checks can never drive a browser they didn't start.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

// KUZA_UI_ROOT points the checks at another copy of docs/, e.g. a deliberately broken one for a positive control.
export const ROOT = resolve(process.env.KUZA_UI_ROOT || new URL('../../docs', import.meta.url).pathname);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function serve(port) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = join(ROOT, path.endsWith('/') ? `${path}index.html` : path);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

export async function startChrome(cdp, profile) {
  const busy = await fetch(`http://127.0.0.1:${cdp}/json/version`).then(() => true, () => false);
  if (busy) throw new Error(`port ${cdp} is already in use by another browser`);
  const proc = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${cdp}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${cdp}/json/version`); break; } catch { await sleep(200); }
  }
  return {
    async stop() { proc.kill('SIGTERM'); await sleep(300); await rm(profile, { recursive: true, force: true }).catch(() => {}); },
  };
}

let id = 0;

export class Tab {
  constructor(ws) { this.ws = ws; this.waiting = new Map(); this.errors = []; this.csp = []; ws.onmessage = (e) => this.onMessage(JSON.parse(e.data)); }
  onMessage(m) {
    if (m.id && this.waiting.has(m.id)) { this.waiting.get(m.id)(m); this.waiting.delete(m.id); }
    if (m.method === 'Fetch.requestPaused') { this.answerRpc(m.params); return; }
    if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded') {
      const text = `${m.params.entry.text} ${m.params.entry.url || ''}`;
      if (/Content Security Policy|Content-Security-Policy/i.test(text)) this.csp.push(text);
      else if (m.params.entry.level === 'error' && !/favicon|ERR_NAME|Failed to load|workers.dev|nimiqwatch|ERR_UNKNOWN_URL_SCHEME|ERR_ABORTED/.test(text)) this.errors.push(text);
    }
  }
  /** Answer the public Nimiq RPC from `handler(method, params)` for this tab only, CORS included. */
  async fakeRpc(handler) {
    this.rpcHandler = handler;
    await this.call('Fetch.enable', { patterns: [{ urlPattern: 'https://rpc.nimiqwatch.com*' }] });
  }
  answerRpc({ requestId, request }) {
    const cors = [{ name: 'access-control-allow-origin', value: '*' }, { name: 'access-control-allow-headers', value: 'content-type' }, { name: 'access-control-allow-methods', value: 'POST' }];
    if (request.method === 'OPTIONS') { this.call('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: cors }); return; }
    let reply;
    try {
      const body = JSON.parse(request.postData || '{}');
      reply = { jsonrpc: '2.0', id: body.id, result: { data: this.rpcHandler(body.method, body.params) } };
    } catch (e) {
      reply = { jsonrpc: '2.0', id: 1, error: { code: -1, message: String(e.message || e) } };
    }
    this.call('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [...cors, { name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify(reply)).toString('base64') });
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
  async go(url, wait = 900) { await this.call('Page.navigate', { url }); await sleep(wait); }
  async shot(path) { const r = await this.call('Page.captureScreenshot', { format: 'png' }); await writeFile(path, Buffer.from(r.data, 'base64')); }
  /** Screenshot of one element, at the device scale, e.g. to read a QR code back. */
  async shotOf(sel, path) {
    const box = await this.eval(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
    const r = await this.call('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 } });
    await writeFile(path, Buffer.from(r.data, 'base64'));
  }
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
  has(sel) { return this.eval(`!!document.querySelector(${JSON.stringify(sel)})`); }
  async waitText(needle, ms = 6000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if ((await this.text()).includes(needle)) return;
      await sleep(100);
    }
    throw new Error(`text not found: ${needle}\n--- page ---\n${(await this.text()).slice(0, 800)}`);
  }
  async waitFor(sel, ms = 6000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await this.has(sel)) return;
      await sleep(100);
    }
    throw new Error(`element not found: ${sel}\n--- page ---\n${(await this.text()).slice(0, 600)}`);
  }
  async noHScroll() { return this.eval('document.documentElement.scrollWidth <= window.innerWidth'); }
}

export async function newTab(cdp, { width = 390, height = 844, ua = null, lang = null } = {}) {
  const res = await fetch(`http://127.0.0.1:${cdp}/json/new?about:blank`, { method: 'PUT' });
  const info = await res.json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  const tab = new Tab(ws);
  await tab.call('Page.enable');
  await tab.call('Runtime.enable');
  await tab.call('Log.enable');
  await tab.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
  if (ua || lang) await tab.call('Emulation.setUserAgentOverride', { userAgent: ua || (await tab.eval('navigator.userAgent')), acceptLanguage: lang || 'en-US,en', platform: (ua || '').includes('iPhone') ? 'iPhone' : 'Linux armv8l' });
  return tab;
}
