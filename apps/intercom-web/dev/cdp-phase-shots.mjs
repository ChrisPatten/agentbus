// Dev helper: render every Phase reference state (?state=<board>/<id>) at 466 x 466 in headless Chrome and compare it with the
// board's PNG. Writes a markdown report with the per-state mismatch and saves the renders (and diff images) to an output dir.
// usage: PORT=3098 node cdp-phase-shots.mjs [outDir] [--refs <plum-dusk dir>] [--report <file.md>] [--only <substring>]
//   The mock server (dev/mock-server.mjs) must be running; it serves the app at /intercom/phase/.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = args[0] && !args[0].startsWith('--') ? args[0] : path.join(os.tmpdir(), 'phase-shots');
const REFS = flag('--refs', path.join(os.homedir(), 'workspace/peggy-claude-code/data/intercom/design/plum-dusk'));
const REPORT = flag('--report', path.join(HERE, '..', 'phase', 'dev', 'SCREENSHOTS.md'));
const ONLY = flag('--only', '');
const PORT = process.env.PORT || 3098;
const BASE = `http://localhost:${PORT}/intercom/phase/`;
const DBG = 9336;
fs.mkdirSync(OUT, { recursive: true });

const index = JSON.parse(fs.readFileSync(path.join(REFS, 'screens', 'index.json'), 'utf8'));
const ids = index.flatMap((b) => b.screens.map((s) => s.id)).filter((id) => !ONLY || id.includes(ONLY));

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${path.join(os.tmpdir(), `phase-cdp-${process.pid}`)}`, '--force-color-profile=srgb', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets = null;
for (let i = 0; i < 50 && !targets; i++) { await sleep(250); try { targets = await (await fetch(`http://127.0.0.1:${DBG}/json`)).json(); } catch { /* Chrome still starting */ } }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const pend = new Map(); const errors = [];
ws.onmessage = (m) => {
  const f = JSON.parse(m.data);
  if (f.id && pend.has(f.id)) { pend.get(f.id)(f.result); pend.delete(f.id); }
  if (f.method === 'Runtime.exceptionThrown') errors.push(f.params.exceptionDetails.exception?.description || f.params.exceptionDetails.text);
  if (f.method === 'Runtime.consoleAPICalled' && f.params.type === 'error') errors.push(f.params.args.map((a) => a.value || a.description).join(' '));
};
const call = (method, params = {}) => new Promise((r) => { pend.set(++n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => (await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
await call('Page.enable'); await call('Runtime.enable');
await call('Emulation.setDeviceMetricsOverride', { width: 466, height: 466, deviceScaleFactor: 1, mobile: false });

// Pixel comparison inside the page (canvas), restricted to the glass (r <= 229: the reference corners show the canvas bezel).
const COMPARE = `async (a, b) => {
  const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const c = document.createElement('canvas'); c.width = 466; c.height = 466; const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(ia, 0, 0); const da = x.getImageData(0, 0, 466, 466).data;
  x.clearRect(0, 0, 466, 466); x.drawImage(ib, 0, 0); const db = x.getImageData(0, 0, 466, 466).data;
  const out = x.createImageData(466, 466); let total = 0, bad = 0, sum = 0;
  for (let y = 0; y < 466; y++) for (let k = 0; k < 466; k++) {
    const i = (y * 466 + k) * 4; const inside = (k - 233) ** 2 + (y - 233) ** 2 <= 229 * 229;
    if (!inside) { out.data[i + 3] = 0; continue; }
    total++;
    const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
    sum += d;
    const g = (da[i] + da[i + 1] + da[i + 2]) / 12;
    if (d > 48) { bad++; out.data[i] = 255; out.data[i + 1] = 40; out.data[i + 2] = 90; out.data[i + 3] = 255; }
    else { out.data[i] = g; out.data[i + 1] = g; out.data[i + 2] = g; out.data[i + 3] = 255; }
  }
  x.putImageData(out, 0, 0);
  return { pct: (100 * bad) / total, mean: sum / total, diff: c.toDataURL('image/png') };
}`;

const rows = [];
for (const id of ids) {
  await call('Page.navigate', { url: `${BASE}?state=${encodeURIComponent(id)}` });
  for (let i = 0; i < 40; i++) { await sleep(100); if (await ev(`document.documentElement.dataset.ready === '1' && document.fonts.status === 'loaded'`)) break; }
  await sleep(250);
  const rect = await ev(`(()=>{const r=document.getElementById('dial').getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height,scale:1}})()`);
  const shot = await call('Page.captureScreenshot', { format: 'png', clip: rect });
  const file = id.replace('/', '__');
  fs.writeFileSync(path.join(OUT, `${file}.png`), Buffer.from(shot.data, 'base64'));
  const ref = fs.readFileSync(path.join(REFS, 'screens', `${id}.png`)).toString('base64');
  const r = await ev(`(${COMPARE})('data:image/png;base64,${shot.data}','data:image/png;base64,${ref}')`);
  fs.writeFileSync(path.join(OUT, `${file}.diff.png`), Buffer.from(r.diff.split(',')[1], 'base64'));
  rows.push({ id, pct: r.pct, mean: r.mean, size: `${Math.round(rect.width)}x${Math.round(rect.height)}` });
  console.log(`${r.pct.toFixed(2).padStart(6)}%  mean ${r.mean.toFixed(1).padStart(5)}  ${id}`);
}
ws.close(); chrome.kill();

const worst = [...rows].sort((a, b) => b.pct - a.pct);
const avg = rows.reduce((a, r) => a + r.pct, 0) / (rows.length || 1);
const md = [
  '# Phase screenshot comparison',
  '',
  `Generated by \`apps/intercom-web/dev/cdp-phase-shots.mjs\` on ${new Date().toISOString().slice(0, 10)}: each \`?state=\` rendered at 466 x 466 in headless Chrome and compared with the board PNG (\`screens/<id>.png\`), pixels inside r 229 only (the reference corners show the canvas bezel).`,
  'A pixel counts as a mismatch when any channel differs by more than 48 of 255. "Mean" is the mean of the per-pixel largest channel difference.',
  '',
  `States: ${rows.length}. Average mismatch: ${avg.toFixed(2)}%.`,
  '',
  '| State | Mismatch | Mean |',
  '|---|---:|---:|',
  ...rows.map((r) => `| \`${r.id}\` | ${r.pct.toFixed(2)}% | ${r.mean.toFixed(1)} |`),
  '',
  '## Worst offenders',
  '',
  ...worst.slice(0, 6).map((r) => `- \`${r.id}\`: ${r.pct.toFixed(2)}%`),
  '',
  'The larger numbers are intended: where spec.md and the board disagree, the spec wins. Capture uses a black ground with no crescent (spec 5.3 and 7.6; the board draws it on plum); the Understood and Thread capsules are 296 wide with the first segment primary (the board: 250 and ghost); Earlier rows are 66 high (board 60); the Settings sliders span 240-300 degrees with spec icons (board 230-310); the resting clock is Numeral L 100 (board 104). Example renders and one diff are in `phase/dev/screenshots/`.',
  '',
  errors.length ? `Console errors: ${errors.length}\n\n${errors.slice(0, 10).map((e) => `- ${e}`).join('\n')}` : 'Console errors: none.',
  '',
];
if (!ONLY) fs.writeFileSync(REPORT, md.join('\n'));
console.log(`\naverage ${avg.toFixed(2)}%  ->  ${OUT}${ONLY ? '' : `\nreport: ${REPORT}`}`);
if (errors.length) { console.log('console errors:'); errors.forEach((e) => console.log(' ', e)); }
