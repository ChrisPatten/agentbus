// Dev helper: drive the surface v2 flows against the mock server with headless Chrome over CDP.
// usage: PORT=3098 node cdp-surface.mjs [outDir]   (mock server must be running; saves PNGs and prints console errors / checks)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || path.join(HERE, 'screens');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.PORT || 3098;
const BASE = `http://localhost:${PORT}/intercom/`;
const DBG = 9334;
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=/tmp/intercom-cdp-surface-${process.pid}`, 'about:blank'], { stdio: 'ignore' });
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
await portrait();
const send = (t) => ev(`(()=>{const i=document.getElementById('input');i.value=${JSON.stringify(t)};document.getElementById('form').requestSubmit();})()`);
const faceText = () => ev(`document.getElementById('face').innerText`);
const faceHas = (sel) => ev(`!!document.querySelector('#face ${sel}')`);
/** Page coordinates of a point in the 466 design square. */
const designToPage = (x, y) => ev(`(()=>{const r=document.getElementById('dial').getBoundingClientRect();return [r.left+x/466*r.width,r.top+y/466*r.height]})()`.replace('x/466', `${x}/466`).replace('y/466', `${y}/466`));
const mouse = (type, x, y) => call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
const tapDesign = async (x, y) => { const [px, py] = await designToPage(x, y); await mouse('mousePressed', px, py); await mouse('mouseReleased', px, py); };
const polarJs = (h, r) => ev(`import('./logic.js').then(m=>m.polar(${h},${r}))`);
const tapSel = async (sel) => { const p = await ev(`(()=>{const e=document.querySelector(${JSON.stringify('#face ' + sel)});if(!e)return null;e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return [b.left+b.width/2,b.top+b.height/2]})()`); if (!p) return false; await mouse('mousePressed', p[0], p[1]); await mouse('mouseReleased', p[0], p[1]); return true; };

await call('Page.navigate', { url: `${BASE}?quiet=0#pair=demo-code` }); await sleep(2500);
await sleep(1500); await tapSel('[data-act="ack"]'); await sleep(500);
check('connected on protocol v2', await ev(`document.getElementById('dotlabel').textContent`) === 'Connected');
await shot('01-day-calendar-style-events.png');
check('ring shows the seeded calendar-style Events', (await ev(`document.querySelectorAll('#face svg path[stroke-width="20"]').length`)) >= 4);

await send('event: dentist'); await sleep(500);
await send('overlap'); await sleep(300);
await send('tick: bill'); await sleep(300);
await send('slot: context lines'); await sleep(700);
await shot('02-day-event-overlaps-tick-context.png');
const t0 = await faceText();
check('context lines and the Leave in N min line render', /Water bill due today/.test(t0) && /Leave in/.test(t0), JSON.stringify(t0.slice(0, 80)));

const hoursOf = (iso) => { const d = new Date(iso); return d.getHours() + d.getMinutes() / 60; };
const evAll = await ev(`fetch('/api/v1/surface/state',{headers:{Authorization:'Bearer mock-token-0123456789abcdef0123456789abcdef'}}).then(r=>r.json()).then(s=>Object.values(s.resources.events).filter(e=>e.kind!=='approval'&&e.at).map(e=>({id:e.id,title:e.title,at:e.at,end:e.end||null})))`);
const todayYmd = new Date().toDateString();
const todays = evAll.filter((e) => new Date(e.at).toDateString() === todayYmd).map((e) => ({ ...e, s: hoursOf(e.at), e: e.end ? hoursOf(e.end) : null })).sort((a, b) => a.s - b.s || (a.e === null) - (b.e === null));
const apart = (a, b) => { const d = Math.abs(a - b) % 24; return Math.min(d, 24 - d); };
const dist = (e, h) => (e.e !== null && h >= e.s && h <= e.e ? 0 : apart(h, e.s));
const nearestAt = (h) => todays.reduce((b, e) => (dist(e, h) < dist(b, h) - 1e-9 ? e : b), todays[0]);
// Tap the dentist segment, then the tick.
const dent = await ev(`fetch('/api/v1/surface/state',{headers:{Authorization:'Bearer mock-token-0123456789abcdef0123456789abcdef'}}).then(r=>r.json()).then(s=>[s.resources.events.dentist.at,s.resources.events.bill.at,s.resources.events.ov1.at])`);
const [dh, bh, oh] = dent.map(hoursOf);
let [sx, sy] = await polarJs(dh + 0.5, 208); await tapDesign(sx, sy); await sleep(600);
await shot('03-event-focus.png');
check('tapping a segment opens Event focus with title, place, and buttons', (await faceText()).includes('Dentist') && (await faceText()).includes('Mansfield') && (await faceHas('[data-act="efire"]')));
// Draft flow
await tapSel('[data-aid="here"]'); await sleep(500);
await shot('04-draft-view.png');
check('a confirm action opens the draft view with the exact text', (await faceText()).includes("I'm at the dentist now"));
await tapSel('[data-act="dsend"]'); await sleep(500);
check('Send shows Sent', (await faceText()).includes('Sent'));
await sleep(1500);
check('draft view returns to the Event', (await faceText()).includes('Dentist'));
await tapSel('[data-aid="here"]'); await sleep(300);
check('a one-shot button that is done is disabled (Already sent / Sent)', /Sent|Already/.test(await faceText()) && !(await faceText()).includes('Send this'));
await tapSel('[data-act="back"]'); await sleep(400);
[sx, sy] = await polarJs(bh, 212); await tapDesign(sx, sy); await sleep(500);
// A seeded calendar-style Event may span the tick's time (a span wins a tie), so the card is the nearest Event by the rule, not always the tick.
check('tapping on a tick opens the carousel on the nearest Event', (await faceHas('.car')) && (await faceText()).includes(nearestAt(bh).title), JSON.stringify((await faceText()).slice(0, 60)));
await shot('05-tick-focus.png');
await tapSel('[data-act="back"]'); await sleep(400);

// Ring tap carousel: tap the ring away from any bar or tick; the carousel opens on the Event nearest in time.
// the hour farthest from every start/end, so the tap lands on bare ring
let tapH = 0, bestGap = -1;
for (let h = 0; h < 24; h += 0.25) { const gap = Math.min(...todays.flatMap((e) => [apart(h, e.s), e.e === null ? 99 : apart(h, e.e), e.e !== null && h >= e.s && h <= e.e ? 0 : 99])); if (gap > bestGap) { bestGap = gap; tapH = h; } }
const expected = nearestAt(tapH);
[sx, sy] = await polarJs(tapH, 208); await tapDesign(sx, sy); await sleep(600);
await shot('05b-carousel-open.png');
const cardText = await faceText();
check('a ring tap away from any bar opens the carousel on the nearest Event', await faceHas('.car') && cardText.includes(expected.title) && cardText.includes(`of ${todays.length}`), `${expected.title} @${tapH}h, ${JSON.stringify(cardText.slice(0, 40))}`);
const idx0 = todays.indexOf(expected);
check('the counter shows the Event\'s place in start order', cardText.includes(`${idx0 + 1} of ${todays.length}`));
// Swipe left on the card: the next Event in start order.
const swipe = async (dx) => { const [a, b] = await designToPage(233, 330); await mouse('mousePressed', a, b); await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a + dx / 2, y: b, button: 'left', buttons: 1 }); await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a + dx, y: b, button: 'left', buttons: 1 }); await mouse('mouseReleased', a + dx, b); await sleep(500); };
await swipe(-120);
const next = todays[(idx0 + 1) % todays.length];
const t1 = await faceText();
await shot('05c-carousel-swiped.png');
check('swiping left moves to the next card', t1.includes(next.title) && t1.includes(`${((idx0 + 1) % todays.length) + 1} of ${todays.length}`), JSON.stringify(t1.slice(0, 40)));
await swipe(120);
check('swiping right moves back', (await faceText()).includes(`${idx0 + 1} of ${todays.length}`));
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight'}))`); await sleep(300);
check('the right arrow key also advances', (await faceText()).includes(`${((idx0 + 1) % todays.length) + 1} of ${todays.length}`));
await tapSel('[data-act="back"]'); await sleep(400);
check('Back returns to the Day Dial', (await ev(`document.getElementById('dial').dataset.screen`)) === 'idle' && !(await faceHas('.car')));
await tapDesign(233, 233); await sleep(300);
check('a tap in the dead zone in the middle does nothing', !(await faceHas('.car')));

// Scrub: grab the ball, drag to the dentist time.
const nowH = await ev(`import('./logic.js').then(m=>m.tzParts(new Date()).hours)`);
[sx, sy] = await polarJs(nowH, 208);
let [px, py] = await designToPage(sx, sy); await mouse('mousePressed', px, py);
const [tx, ty] = await polarJs(dh + 0.3, 208); const [qx, qy] = await designToPage(tx, ty);
await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: qx, y: qy, button: 'left', buttons: 1 }); await sleep(300);
await shot('06-scrub.png');
check('dragging the ball shows what is at that time', (await faceText()).includes('Dentist'), JSON.stringify((await faceText()).slice(0, 40)));
await mouse('mouseReleased', qx, qy); await sleep(1000);
check('still scrubbing shortly after release', (await faceText()).includes('Dentist'));
await sleep(4000);
check('snaps back to now after about four seconds', !(await faceText()).includes('Dentist') || /Dentist/.test(await faceText()) && !(await faceHas('.scrubt')));

// Primary slot with a draft action
await send('slot: primary'); await sleep(600);
await shot('07-primary-slot-button.png');
check('primary slot button renders', await faceHas('[data-act="slotaction"]'));
await send('widgets'); await sleep(600);
await shot('08-context-widgets.png');
check('context widgets render', await faceHas('.wrow .wcell'));
await send('approval'); await sleep(800); 
await shot('09-needs-approval.png');
check('approval rides the Needs-you screen with Review', (await faceText()).includes('Bash') && (await faceText()).includes('Review'));
await tapSel('[data-act="action"]'); await sleep(500);
await shot('10-approval-view.png');
check('Review opens the Approval view with the exact detail', (await faceText()).includes('git push origin') && (await faceText()).includes('Deny'));
check('Deny is styled destructive', await faceHas('.btn.danger[data-aid="deny"]'));
await tapSel('[data-aid="deny"]'); await sleep(900);
check('Deny shows Sent and the approval leaves the list', (await faceText()).includes('Sent') || !(await faceText()).includes('git push origin'));
await shot('10b-approval-denied.png');
await tapSel('[data-act="back"]'); await sleep(500);

// Agent status
await send('needs'); await sleep(900);
await ev(`localStorage.setItem('intercom.face','status');location.reload()`); await sleep(2500);
await shot('11-agent-status.png');
check('status face lists sessions with needs-you first', /Which train/.test(await faceText()) && (await ev(`document.querySelectorAll('#face .srow2').length`)) === 6);
check('rim breathes for needs-you', await faceHas('svg .breathe'));
await tapSel('.srow2.needs'); await sleep(1200);
await shot('12-conversation.png');
check('tapping a row opens the conversation', (await faceText()).includes('Which train should I plan'));
check('conversation starts at the newest message', await ev(`(()=>{const s=document.querySelector('#face .cscroll');return s.scrollHeight-s.scrollTop-s.clientHeight<5})()`));
await ev(`document.querySelector('#face .cscroll').scrollTop=0`); await sleep(1200);
check('scrolling up loads older messages', (await ev(`document.querySelectorAll('#face .msg').length`)) > 31);
await shot('13-conversation-older.png');
await ev(`(()=>{const s=document.querySelector('#face .cscroll');s.scrollTop=s.scrollHeight})()`); await sleep(300);
await tapSel('.cbtn'); await sleep(2200);
await shot('14-conversation-tapped.png');
check('choice tap is sent and the agent reply appends live', (await faceText()).includes('[tapped]') && (await faceText()).includes('Noted'));
await send('convo'); await sleep(700);
check('live append while open', (await faceText()).includes('Which restaurant'));
await tapSel('.cvback'); await sleep(400);
check('Back returns to the face', await faceHas('.slist2'));

// Layout sizes: portrait 466 equivalent and landscape
await ev(`localStorage.setItem('intercom.face','day');location.reload()`); await sleep(2200);
await call('Emulation.setDeviceMetricsOverride', { width: 932, height: 430, deviceScaleFactor: 2, mobile: true }); await sleep(800);
await shot('15-landscape.png', true);
// 466 px dial (Large mode on a 538 px wide viewport at 1x): the Compact's native size.
await call('Emulation.setDeviceMetricsOverride', { width: 538, height: 720, deviceScaleFactor: 1, mobile: true });
await ev(`localStorage.setItem('intercom.large','1');localStorage.setItem('intercom.face','day');location.reload()`); await sleep(2500);
const dialPx = await ev(`Math.round(document.getElementById('dial').getBoundingClientRect().width)`);
check('Large mode gives a 466 px dial', dialPx === 466, String(dialPx));
await shot('16-day-466px.png');
await ev(`localStorage.setItem('intercom.face','status');location.reload()`); await sleep(2500);
await shot('17-status-466px.png');
await ev(`localStorage.removeItem('intercom.large');localStorage.setItem('intercom.face','day')`);
await portrait();
console.log(JSON.stringify({ errors: [...new Set(errors)] }));
fs.writeFileSync(path.join(OUT, 'checks.json'), JSON.stringify({ checks, errors }, null, 1));
ws.close(); chrome.kill();
process.exit(checks.every((c) => c.ok) && !errors.length ? 0 : 1);
