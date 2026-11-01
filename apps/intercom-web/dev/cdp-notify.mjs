// Dev helper: drive the notification flow (E89) against the mock server with headless Chrome over CDP.
// usage: PORT=3097 node cdp-notify.mjs   (mock server on that port; writes notify-*.png to screenshots/)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=9334', '--user-data-dir=/tmp/intercom-cdp-notify', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2000);
const targets = await (await fetch('http://localhost:9334/json')).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const f = JSON.parse(m.data); if (f.id && pend.has(f.id)) { pend.get(f.id)(f.result); pend.delete(f.id); } };
const call = (method, params = {}) => new Promise((r) => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = (expression) => call('Runtime.evaluate', { expression, awaitPromise: true });
const shot = async (name) => { const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64')); };
await call('Page.enable');
await call('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
const PORT = process.env.PORT || 3098;
const BASE = `http://localhost:${PORT}/intercom/`;
const text = async () => (await ev(`document.getElementById('face').innerText`)).result.value;
await call('Page.enable');
await call('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
await call('Page.navigate', { url: BASE + '#pair=demo-code' }); await sleep(1500);
await ev(`localStorage.setItem('intercom.large','1')`);
await call('Page.navigate', { url: BASE + '?quiet=0' }); await sleep(1800);

await sleep(2200); console.log('needs:', JSON.stringify(await text()));
const send = (t) => ev(`(()=>{const i=document.getElementById('input');i.value=${JSON.stringify(t)};document.getElementById('form').requestSubmit();})()`);
await send('notify!: Leave for the dentist'); await sleep(200);
await send('notify: Draft awaiting your OK'); await sleep(6400);
await shot('notify-3-urgent-grid.png'); console.log('grid:', JSON.stringify(await text()));
await ev(`document.querySelector('[data-act=cycle]').click()`); await sleep(400);
await ev(`document.querySelector('[data-act=action][data-i="0"]').click()`); await sleep(900);
await sleep(7500); console.log('after action:', JSON.stringify(await text()));
await ev(`document.querySelector('[data-act=ack]').click()`); await sleep(600);
console.log('after got it:', JSON.stringify(await text()));
await send('clear:'); await sleep(300);
await send('note: Mail Watcher finished'); await sleep(6400); await shot('notify-6-idle-note.png');
await ev(`document.querySelector('[data-act=note]').click()`); await sleep(500); await shot('notify-7-note-open.png');
await ev(`document.querySelector('[data-act=ack]').click()`); await sleep(600); console.log('idle again:', JSON.stringify(await text()));
await send('notify: Bill due today'); await sleep(6400);
await call('Page.navigate', { url: BASE + '?quiet=1' }); await sleep(2000); await shot('notify-8-quiet.png'); console.log('quiet:', JSON.stringify(await text()));
for (const n of [6, 10]) { await call('Page.navigate', { url: BASE + `?demo=${n}&hold` }); await sleep(900); await shot(n === 6 ? 'demo-6.png' : `notify-demo-${n}.png`); }
ws.close(); chrome.kill();
