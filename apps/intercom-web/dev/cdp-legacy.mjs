// Dev helper: drive the legacy fallback against the mock server started with MOCK_NO_V2=1 (no v2 path), checking the app stays on protocol v1 with headless Chrome over CDP.
// usage: PORT=3098 node cdp-legacy.mjs [outDir]   (run the mock with MOCK_NO_V2=1)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || path.join(HERE, 'screens');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.PORT || 3098;
const BASE = `http://localhost:${PORT}/intercom/`;
const DBG = 9335;
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=/tmp/intercom-cdp-legacy-${process.pid}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2200);
const targets = await (await fetch(`http://localhost:${DBG}/json`)).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const errors = []; const log = [];
ws.onmessage = (m) => {
  const f = JSON.parse(m.data);
  if (f.id && pend.has(f.id)) { pend.get(f.id)(f.result); pend.delete(f.id); }
  if (f.method === 'Runtime.exceptionThrown') errors.push(f.params.exceptionDetails.exception?.description || f.params.exceptionDetails.text);
  if (f.method === 'Runtime.consoleAPICalled' && f.params.type === 'error') errors.push(f.params.args.map((a) => a.value || a.description).join(' '));
  if (f.method === 'Log.entryAdded' && f.params.entry.level === 'error') errors.push(`${f.params.entry.text} ${f.params.entry.url || ''}`);
};
const call = (method, params = {}) => new Promise((r) => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => (await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
// Screenshots are clipped to the dial and its bezel (small files); the landscape shot is the whole page.
const shot = async (name, full = false) => {
  let clip;
  if (!full) { const b = await ev(`(()=>{const r=document.querySelector('.bezel').getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height,scale:1}})()`); clip = b; }
  const r = await call('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
};
const checks = [];
const check = (name, ok, extra = '') => { checks.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); };
await call('Page.enable'); await call('Runtime.enable'); await call('Log.enable');
const portrait = () => call('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
await call('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
const send = (t) => ev(`(()=>{const i=document.getElementById('input');i.value=${JSON.stringify(t)};document.getElementById('form').requestSubmit();})()`);
const faceText = () => ev(`document.getElementById('face').innerText`);
await call('Page.navigate', { url: `${BASE}?quiet=0#pair=demo-code` }); await sleep(9000); // two failed v2 attempts, then the legacy path
const dot = await ev(`document.getElementById('dotlabel').textContent`);
check('connects over the legacy path when v2 is unavailable', dot === 'Connected', dot);
await ev(`(()=>{const b=document.querySelector('#face [data-act="ack"]');if(b)b.click()})()`); await sleep(400);
check('calendar-derived ring draws on the legacy path', (await ev(`document.querySelectorAll('#face svg path[stroke-width="20"],#face svg path[stroke-width="10"]').length`)) >= 4);
check('the legacy path still shows the next calendar event', /·/.test(await faceText()), JSON.stringify((await faceText()).slice(0, 60)));
await send('desk: needs'); await sleep(600);
await ev(`localStorage.setItem('intercom.face','status');location.reload()`); await sleep(3000);
const t = await faceText();
check('status face falls back to the desk sessions', /Intercom Build/.test(t), JSON.stringify(t.slice(0, 80)));
const st = await ev(`document.getElementById('face').querySelectorAll('.srow2').length`);
check('desk sessions are listed', st >= 3, String(st));
await shot('legacy-status.png');
console.log(JSON.stringify({ errors: [...new Set(errors)] }));
ws.close(); chrome.kill();
process.exit(checks.every((c) => c.ok) && !errors.length ? 0 : 1);
