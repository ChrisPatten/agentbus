// Dev helper: drive the live (non-demo) Phase client against its own mock bus with headless Chrome and check the main flows:
// pairing, Moments on the rim, a notice, a decision with hold-to-confirm (and an early release that sends nothing), event detail,
// a waiting job, faces, Settings and Earlier, push-to-talk and Capture stand-ins, offline and reconnect, console errors.
// usage: node cdp-phase-live.mjs [outDir]   (starts dev/mock-server.mjs itself on PORT, default 3197; prints PASS / FAIL)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || path.join(os.tmpdir(), 'phase-live');
fs.mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.PORT || 3197);
const BASE = `http://localhost:${PORT}/intercom/phase/`;
const DBG = 9338;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let mock = null;
const portBusy = async () => { try { await fetch(`http://127.0.0.1:${PORT}/intercom/phase/`); return true; } catch { return false; } };
const startMock = async () => {
  if (await portBusy()) { console.error(`port ${PORT} is already in use: stop that server or set PORT`); process.exit(2); }
  mock = spawn(process.execPath, [path.join(HERE, 'mock-server.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 30 && !(await portBusy()); i++) await sleep(100);
};
const stopMock = async () => { if (mock) { mock.kill('SIGKILL'); mock = null; await sleep(300); } };
await startMock();
let chrome = null;
const cleanup = () => { try { chrome && chrome.kill(); } catch { /* gone */ } try { mock && mock.kill('SIGKILL'); } catch { /* gone */ } };
process.on('exit', cleanup);
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); cleanup(); process.exit(1); });

chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${path.join(os.tmpdir(), `phase-live-${process.pid}`)}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let targets = null;
for (let i = 0; i < 50 && !targets; i++) { await sleep(250); try { targets = await (await fetch(`http://127.0.0.1:${DBG}/json`)).json(); } catch { /* Chrome still starting */ } }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const pend = new Map(); const errors = [];
let offlinePhase = false;
ws.onmessage = (m) => {
  const f = JSON.parse(m.data);
  if (f.id && pend.has(f.id)) { pend.get(f.id)(f.result); pend.delete(f.id); }
  if (f.method === 'Runtime.exceptionThrown') errors.push(f.params.exceptionDetails.exception?.description || f.params.exceptionDetails.text);
  if (f.method === 'Runtime.consoleAPICalled' && f.params.type === 'error') errors.push(f.params.args.map((a) => a.value || a.description).join(' '));
  if (f.method === 'Log.entryAdded' && f.params.entry.level === 'error') { const t = `${f.params.entry.text} ${f.params.entry.url || ''}`; if (!(offlinePhase && /WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource/.test(t))) errors.push(t); }
};
const call = (method, params = {}) => new Promise((r) => { pend.set(++n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => (await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
await call('Page.enable'); await call('Runtime.enable'); await call('Log.enable');
await call('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });

const checks = [];
const check = (name, ok, extra = '') => { checks.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`); };
const screen = () => ev(`(document.querySelector('#face .ph:last-child')||{}).dataset?.screen||''`);
const faceText = () => ev(`(document.querySelector('#face .ph:last-child')||{}).innerText||''`);
const shot = async (name) => {
  const clip = await ev(`(()=>{const r=document.getElementById('dial').getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height,scale:1}})()`);
  const r = await call('Page.captureScreenshot', { format: 'png', clip });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
};
const send = async (t) => { await ev(`(()=>{const i=document.getElementById('input');i.value=${JSON.stringify(t)};document.getElementById('form').requestSubmit();})()`); await sleep(500); };
// Mock commands are typed messages, so each opens Understood; a power click returns to Now (only when nothing else took the glass).
const cmd = async (t) => { await send(t); if ((await screen()) === 'understood') { await hw('power'); await sleep(250); } };
const allText = () => ev(`(document.querySelector('#face .ph:last-child')||{}).textContent||''`);
const toPage = (x, y) => ev(`(()=>{const r=document.getElementById('dial').getBoundingClientRect();return [r.left+${x}/466*r.width,r.top+${y}/466*r.height]})()`);
const mouse = (type, x, y) => call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
const tapAt = async (x, y, holdMs = 0) => { const [px, py] = await toPage(x, y); await mouse('mousePressed', px, py); if (holdMs) await sleep(holdMs); await mouse('mouseReleased', px, py); await sleep(250); };
const centerOf = (sel) => ev(`(()=>{const e=document.querySelector('#face .ph:last-child ${sel}');if(!e)return null;const d=document.getElementById('dial').getBoundingClientRect();const b=e.getBoundingClientRect();return [(b.left+b.width/2-d.left)/d.width*466,(b.top+b.height/2-d.top)/d.height*466]})()`);
const tapSel = async (sel, holdMs = 0) => { const p = await centerOf(sel); if (!p) return false; await tapAt(p[0], p[1], holdMs); return true; };
const swipe = async (dx, dy) => { const [x, y] = await toPage(233, 233); await mouse('mousePressed', x, y); await mouse('mouseMoved', x + dx / 2, y + dy / 2); await mouse('mouseMoved', x + dx, y + dy); await mouse('mouseReleased', x + dx, y + dy); await sleep(450); };
const hw = async (id, holdMs = 60) => { await ev(`document.getElementById('${id}').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`); await sleep(holdMs); await ev(`document.getElementById('${id}').dispatchEvent(new PointerEvent('pointerup',{bubbles:true}))`); await sleep(200); };
const actionsPosted = () => ev('window.__posts||0');
const waitFor = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(150); } return false; };

// 1. Pairing (fragment) and the first frame.
await call('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const f=window.fetch;window.__posts=0;window.fetch=function(u,o){if(String(u).includes('/surface/actions'))window.__posts++;return f.apply(this,arguments)}})()` });
await call('Page.navigate', { url: `${BASE}?quiet=0` });
check('unpaired, the dial shows the Pairing screen', await waitFor(async () => (await screen()) === 'pairing', 4000), await screen());
await ev(`(()=>{const i=document.getElementById('input');i.value='https://bus.example/intercom/#pair=demo-code';i.dispatchEvent(new Event('input'))})()`); await sleep(300);
check('a pasted pairing link shows its code on the dial', /DEMO/.test(await faceText()));
await shot('00-pairing.png');
await ev(`document.getElementById('form').requestSubmit()`);
check('pairs with a pasted code and connects on protocol 2', await waitFor(async () => (await ev(`document.getElementById('dotlabel').textContent`)) === 'Connected', 6000));
check('stores the pairing under intercom.pair (shared with the main client)', !!(await ev(`JSON.parse(localStorage.getItem('intercom.pair')||'null')?.token`)));
// 2. The sample attention notice takes the face as a Decision.
check('an attention notice takes the face as a Decision', await waitFor(async () => (await screen()) === 'decision', 5000), await screen());
await shot('01-decision-notice.png');
check('the decision names who needs you and shows LATER', /NEEDS YOU/.test(await faceText()) && /LATER/.test(await faceText()));
await tapSel('[data-act="later"]'); await sleep(500);
check('LATER sets it aside and returns to Now', (await screen()) === 'now', await screen());
const rimMarks = () => ev(`document.querySelectorAll('#face .ph:last-child svg.layer:first-child path[stroke-linecap="round"], #face .ph:last-child svg.layer:first-child circle[r="4"]').length`);
const before = await rimMarks();
check('seeded calendar Moments are drawn on the rim (or the face is NOTHING ON)', before > 0 || /NOTHING ON/.test(await faceText()), `marks=${before}`);
await cmd('travel'); await sleep(600);
check('a new Moment adds a rim mark', (await rimMarks()) > before, `${before} -> ${await rimMarks()}`);
await shot('02-now-with-moments.png');
// 3. Earlier holds the set-aside notice (swipe up), and the open row can be re-opened.
await swipe(0, -160);
check('swipe up opens Earlier with the set-aside item open', (await screen()) === 'earlier' && /tap to act/i.test(await faceText()), await screen());
await shot('03-earlier.png');
await swipe(0, 160);
check('swipe down closes Earlier', (await screen()) === 'now', await screen());
// 4. An info notice shows the Inform screen; GOT IT clears it.
await send('note: Package delivered'); await sleep(700);
check('an info notice shows Inform with CLEARS IN', (await screen()) === 'inform' && /CLEARS IN/.test(await faceText()), await screen());
await shot('04-inform.png');
await tapSel('[data-act="gotit"]'); await sleep(500);
check('GOT IT clears the notice', ['now', 'understood'].includes(await screen()), await screen());
await hw('power'); await sleep(300);
// 5. An urgent notice floods rose with a rim drain; Dismiss acks it.
await send('notify!: Train delayed'); await sleep(900);
check('an urgent notice floods the glass rose', (await screen()) === 'urgent' && (await ev(`!!document.querySelector('#face .ph.g-rose')`)), await screen());
check('the urgent face has two pills and no progress arcs', (await ev(`document.querySelectorAll('#face .ph:last-child .pill').length`)) === 2 && !(await ev(`document.querySelector('#face .ph:last-child path[d^="M103.1 158"]')`)));
await shot('05-urgent.png');
const posts0 = await actionsPosted();
await tapSel('.pill[data-act="aact"]'); await sleep(900);
check('a pill tap posts once and shows SENT only after the bus answers', (await actionsPosted()) === posts0 + 1 && (await screen()) === 'sent', await screen());
await shot('06-sent.png');
await sleep(5600);
check('Sent returns to Now after 5 s', (await screen()) === 'now', await screen());
// 6. Approval: decision -> Review -> Confirm; an early release sends nothing; a full 0.8 s hold sends.
await cmd('approval'); await sleep(800);
check('a bus approval takes the face as a Decision', (await screen()) === 'decision', await screen());
await tapSel('[data-act="review"]'); await sleep(500);
check('Review opens Confirm with the exact text', (await screen()) === 'confirm' && /git push origin feat\/surface-web-v2/.test(await faceText()), await screen());
await shot('07-confirm.png');
const p1 = await actionsPosted();
await tapSel('.holdtarget', 400);
check('releasing the hold before 0.8 s sends nothing', (await actionsPosted()) === p1 && (await screen()) === 'confirm');
await tapSel('.holdtarget', 1100); await sleep(700);
check('a full hold sends once and shows Sent', (await actionsPosted()) === p1 + 1 && (await screen()) === 'sent', await screen());
await sleep(5400);
// 6b. E100 Moments from the bus: an urgent Event with a changed time and a consequence; withdrawn by the agent it leaves the glass
// for Earlier with that word; a decision's plain hold button fires only on a completed hold, and the answered Moment never returns.
await cmd('urgent'); await sleep(800);
const ut = await faceText();
check('an urgent Event shows the struck-through old time, the new time and the consequence', (await screen()) === 'urgent' && /6:42/.test(ut) && /6:58/.test(ut) && /MISSES YOUR 7:15 TRANSFER/.test(ut), ut.replace(/\n/g, ' '));
check('the old time is struck through', await ev(`[...document.querySelectorAll('#face .ph:last-child .t')].some((e)=>e.textContent==='6:42'&&/line-through/.test(e.style.textDecoration||e.style.textDecorationLine))`));
await shot('07b-urgent-changed.png');
await send('end: train-delay withdrawn'); await sleep(900);
if ((await screen()) === 'understood') { await hw('power'); await sleep(250); }
check('withdrawn by the agent, the urgent Moment leaves the glass', !['urgent', 'alert'].includes(await screen()), await screen());
await swipe(0, -160);
check('Earlier shows it marked withdrawn', (await screen()) === 'earlier' && /TRAIN DELAYED[\s\S]*withdrawn/i.test(await faceText()), (await faceText()).replace(/\n/g, ' '));
await shot('07c-earlier-withdrawn.png');
await swipe(0, 160);
await cmd('decide'); await sleep(800);
check('a decision Moment takes the face', (await screen()) === 'decision', await screen());
check('its irreversible button is a hold', await ev(`!!document.querySelector('#face .ph:last-child [data-aid="cancel"][data-hold]')`));
const p2 = await actionsPosted();
await tapSel('[data-aid="cancel"]', 120);
check('a short tap on a hold button sends nothing', (await actionsPosted()) === p2 && (await screen()) === 'decision', await screen());
await tapSel('[data-aid="cancel"]', 1100); await sleep(700);
check('a full hold sends once', (await actionsPosted()) === p2 + 1, `${p2} -> ${await actionsPosted()}`);
await sleep(5600);
check('the answered decision does not come back', (await screen()) !== 'decision', await screen());
// 7. Event detail through the Day list, with a confirm-draft action.
await cmd('event: dentist'); await sleep(500);
await swipe(160, 0);
check('swipe right from Now shows Day', (await screen()) === 'day', await screen());
await shot('08-day.png');
const hasRow = await tapSel('.drow[data-id="dentist"]');
await sleep(500);
check('tapping a Day row opens Event detail', hasRow && (await screen()) === 'detail' && /DENTIST/i.test(await faceText()), await screen());
await shot('09-detail.png');
await tapSel('.seg[data-aid="here"]'); await sleep(500);
check('a draft action opens Confirm with the exact draft', (await screen()) === 'confirm' && /Back around 5:30/.test(await faceText()));
await tapSel('[data-act="ccancel"]'); await sleep(400);
check('Cancel returns to the detail with nothing sent', (await screen()) === 'detail');
await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await sleep(100);
await hw('power'); await sleep(400);
check('a power click returns to Now', (await screen()) === 'now', await screen());
// 8. Agents and a waiting job.
await cmd('sessions'); await sleep(500);
check('the count ring on Now counts working jobs', (await ev(`[...document.querySelectorAll('#face .ph:last-child .t')].find((e)=>e.style.left==='30px')?.textContent`)) === '2');
await swipe(-160, 0);
check('swipe left from Now shows Agents with rows', (await screen()) === 'agents' && (await ev(`document.querySelectorAll('#face .ph:last-child .erow').length`)) >= 2, await screen());
await shot('10-agents.png');
await cmd('needs'); await sleep(1500);
check('a job that needs you takes the face with its question', (await screen()) === 'waiting' && /Which train/.test(await faceText()), await faceText());
await shot('11-waiting.png');
await tapSel('.seg[data-act="qopt"]'); await sleep(900);
check('answering the question shows Sent after the bus answers', (await screen()) === 'sent', await screen());
await sleep(5400);
await swipe(-160, 0); await swipe(-160, 0);
check('Thread face shows the latest agent message', await waitFor(async () => (await screen()) === 'thread' && /Noted: The 6008/.test(await faceText()), 4000), await faceText());
await shot('12-thread.png');
await hw('power'); await sleep(300);
// 9. Settings: sliders, Daylight picker.
await swipe(0, 160);
check('swipe down opens Settings', (await screen()) === 'settings', await screen());
await tapSel('[data-act="sdaylight"]'); await sleep(400);
check('Daylight opens the city list with phone location first', (await screen()) === 'cities' && /USE PHONE LOCATION/i.test(await faceText()));
await tapSel('[data-act="city"][data-i="2"]'); await sleep(500);
check('picking Boston returns to Settings showing BOSTON', (await screen()) === 'settings' && /BOSTON/.test(await faceText()));
await shot('13-settings.png');
await ev(`(()=>{const s=JSON.parse(localStorage.getItem('phase.settings'));s.loc={city:'Mansfield',lat:42.0334,lon:-71.219,source:'picked'};localStorage.setItem('phase.settings',JSON.stringify(s))})()`);
await swipe(0, -160);
check('swipe up closes Settings', (await screen()) === 'now', await screen());
// 10. Push-to-talk and Capture stand-ins.
await ev(`document.getElementById('side').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`); await sleep(600);
check('holding the side button shows Listening', (await screen()) === 'listening', await screen());
await shot('14-listening.png');
const posts2 = await actionsPosted();
await hw('power', 40);
await ev(`document.getElementById('side').dispatchEvent(new PointerEvent('pointerup',{bubbles:true}))`); await sleep(400);
check('a power click while holding cancels with nothing sent', (await screen()) !== 'listening' && (await actionsPosted()) === posts2);
await hw('side', 40); await sleep(60); await hw('side', 40); await sleep(400);
check('a double-press starts Capture (REC on true black)', (await screen()) === 'recording' && (await ev(`!!document.querySelector('#face .ph.g-black')`)));
await shot('15-recording.png');
await tapSel('[data-act="capstop"]', 1000); await sleep(400);
check('HOLD TO STOP ends Capture and the Saved screen says it is a prototype', (await screen()) === 'saved' && /Prototype/.test(await faceText()));
await sleep(5400);
// 11. Typed send: Understood, then the answer.
await send('hello there'); await sleep(400);
check('a typed send shows Understood with the text', (await screen()) === 'understood' && /hello there/.test(await faceText()));
check('UNDERSTOOD appears once the bus acknowledges', await waitFor(async () => /UNDERSTOOD/.test(await faceText()), 3000));
check('the answer arrives from the bus', await waitFor(async () => /dentist|note/i.test(await faceText()), 8000), (await faceText()).slice(0, 80));
await shot('16-understood.png');
await hw('power'); await sleep(300);
// 12. Offline and reconnect.
offlinePhase = true;
await stopMock();
await waitFor(async () => (await screen()) === 'offline', 8000);
check('socket down shows the Offline screen (dashed rim, RECONNECTING)', (await screen()) === 'offline' && /~|NOTHING ON/.test(await allText()) && /RECONNECTING/.test(await allText()) && /OFFLINE SINCE/.test(await allText()) && !!(await ev(`document.querySelector('#face .ph:last-child circle[stroke-dasharray="10 12.4"]')`)), `${await screen()} ${await ev(`document.getElementById('dotlabel').textContent`)} ${(await allText()).slice(0, 80)}`);
check('the moon keeps running offline', !!(await ev(`document.querySelector('#face .ph:last-child .moon')`)));
await shot('17-offline.png');
await startMock();
check('reconnects without ceremony', await waitFor(async () => (await screen()) !== 'offline' && (await ev(`document.getElementById('dotlabel').textContent`)) === 'Connected', 15000), await screen());
offlinePhase = false;
await sleep(500);
// 13. Landscape hides the chrome.
await call('Emulation.setDeviceMetricsOverride', { width: 932, height: 430, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } });
await sleep(400);
check('landscape hides the page chrome', (await ev(`getComputedStyle(document.getElementById('under')).display`)) === 'none');
await call('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(path.join(OUT, '18-landscape.png'), Buffer.from(r.data, 'base64')));

await call('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } });
await sleep(300);
// 14. Settings slider drag; the power menu stub.
await swipe(0, 160);
{ const a = (258 * Math.PI) / 180; const [x, y] = await toPage(233 + 214 * Math.sin(a), 233 - 214 * Math.cos(a)); const [x2, y2] = await toPage(233 + 214 * Math.sin((270 * Math.PI) / 180), 233 - 214 * Math.cos((270 * Math.PI) / 180));
  await mouse('mousePressed', x, y); await mouse('mouseMoved', x2, y2); await mouse('mouseReleased', x2, y2); await sleep(300); }
const br = await ev(`JSON.parse(localStorage.getItem('phase.settings')).brightness`);
check('dragging the left rim slider sets brightness', Math.abs(br - 0.5) < 0.08, String(br));
check('brightness dims the glass with an overlay', Number(await ev(`getComputedStyle(document.getElementById('bright')).opacity`)) > 0.3);
await ev(`(()=>{const s=JSON.parse(localStorage.getItem('phase.settings'));s.brightness=1;localStorage.setItem('phase.settings',JSON.stringify(s))})()`);
await swipe(0, -160);
await hw('power', 3300);
check('holding power 3 s opens the power menu', (await screen()) === 'power', await screen());
await tapSel('[data-act="pcancel"]');
// 15. Quiet hours: rest in the night layout, wake shows END QUIET HOURS, which ends them.
await call('Page.navigate', { url: `${BASE}?quiet&fast` });
check('in quiet hours an untouched dial rests in the night layout', await waitFor(async () => (await screen()) === 'rest' && /QUIET UNTIL/.test(await faceText()), 6000), await screen());
await shot('19-rest-night.png');
await tapAt(233, 233); await sleep(300);
// The mock raises its sample attention notice again on every connect; once awake the glass shows it, so set it aside first.
if ((await screen()) === 'decision') { await tapSel('[data-act="later"]'); await sleep(400); }
check('a touch wakes it to the night Now face with END QUIET HOURS', (await screen()) === 'woken' && /END QUIET HOURS/.test(await faceText()), `${await screen()} ${(await faceText()).slice(0, 60)}`);
await shot('20-woken.png');
await tapSel('[data-act="endquiet"]'); await sleep(400);
check('END QUIET HOURS returns to the plum faces', (await screen()) === 'now', await screen());
// 16. Outside quiet hours: dim to 40% after the idle time, then rest as dimmed Now; a touch wakes.
await call('Page.navigate', { url: `${BASE}?quiet=0&fast` });
await sleep(4200);
check('untouched, the glass dims to 40%', Math.abs(Number(await ev(`document.getElementById('dimmer').style.opacity`)) - 0.6) < 0.01);
await tapAt(233, 420); await sleep(300);
check('a touch brings it back to full brightness', Number(await ev(`document.getElementById('dimmer').style.opacity`)) === 0);
// 17. #pair= in the URL (as the current client accepts it) re-pairs.
await call('Page.navigate', { url: `${BASE}?quiet=0#pair=demo-code` });
check('pairs from #pair= and removes the fragment', await waitFor(async () => (await ev(`document.getElementById('dotlabel').textContent`)) === 'Connected' && !(await ev('location.hash')), 6000));

check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
ws.close(); chrome.kill(); await stopMock();
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} passed; screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
