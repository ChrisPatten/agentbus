/**
 * Siri bridge latency probe (E42 / S42.5, Gate 1).
 *
 * Asks the live bus a mix of questions through `POST /api/v1/siri/ask` — the
 * exact path the Peggy iOS app uses — and reports per-ask `queued_ms` /
 * `answered_ms` plus p50 / p95 / max / timeouts per class and overall. Writes
 * every row to a CSV so runs can be compared in
 * _bmad-output/planning-artifacts/siri-bridge/spike-results.md.
 *
 * Usage:
 *   npx tsx scripts/siri-probe.ts [--base http://127.0.0.1:3000] [--token <siri token>]
 *                                 [--n 20] [--mix trivial:8,memory:8,tool:4]
 *                                 [--wait 25000] [--pause 3000] [--csv <path>]
 *
 *   --token   defaults to $SIRI_TOKEN_CHRIS, loaded from ./.env.
 *   --mix     how many asks of each class; --n scales the mix proportionally.
 *   --wait    wait_ms sent with each ask (the bus caps it at reply_timeout_ms).
 *   --pause   ms between asks. Keep it ≥ 3000: the pipeline drops an identical
 *             question from the same contact within pipeline.dedup_window_ms
 *             (30 s), and the answering agent serializes turns per contact, so
 *             back-to-back asks measure queueing, not latency.
 *   --csv     defaults to ~/.agentbus/siri-probe-<timestamp>.csv
 *
 * The question banks below are editable. Memory questions must be things the
 * agent actually knows from its memory files; tool questions must need a tool
 * (calendar, weather, mail). Do not chat with the agent on another channel
 * while a run is in progress — those turns queue ahead of the probe's.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: resolve(process.cwd(), '.env') });

type Cls = 'trivial' | 'memory' | 'tool';

const BANKS: Record<Cls, string[]> = {
  trivial: [
    'What day of the week is it today?',
    'What is 17 times 23?',
    'Say good morning in French.',
    'What year is it?',
    'What is the capital of Vermont?',
    'How many minutes are in three and a half hours?',
    'Give me a one-sentence pep talk.',
    'What is ten percent of 250?',
  ],
  memory: [
    'Which town do I live in?',
    'What is the name of my Homebridge plugin for the kids Yoto players?',
    'Which school does Johnny go to now?',
    'Which dance studio does Gracie go to?',
    'Where do my parents live?',
    'When is my wedding anniversary?',
    'Who is Papa?',
    'Where do I work?',
  ],
  tool: [
    'What is on my calendar tomorrow?',
    'What is the weather like right now in Mansfield?',
    'Do I have any new email from the last hour?',
    'When is my next meeting?',
  ],
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const base = arg('base', 'http://127.0.0.1:3000').replace(/\/$/, '');
const token = arg('token', process.env['SIRI_TOKEN_CHRIS'] ?? '');
const waitMs = Number(arg('wait', '25000'));
const pauseMs = Number(arg('pause', '3000'));
const mixArg = arg('mix', 'trivial:8,memory:8,tool:4');
const nOverride = process.argv.includes('--n') ? Number(arg('n', '20')) : null;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const csvPath = arg('csv', join(homedir(), '.agentbus', `siri-probe-${stamp}.csv`));

if (!token) {
  console.error('No token: pass --token or set SIRI_TOKEN_CHRIS in .env');
  process.exit(1);
}

function parseMix(spec: string): Map<Cls, number> {
  const mix = new Map<Cls, number>();
  for (const part of spec.split(',')) {
    const [cls, count] = part.split(':') as [Cls, string];
    if (!(cls in BANKS)) {
      console.error(`Unknown class "${cls}" in --mix (expected trivial|memory|tool)`);
      process.exit(1);
    }
    mix.set(cls, Number(count ?? '0'));
  }
  return mix;
}

/** Weighted round-robin so classes are spread across the run rather than blocked together. */
function buildSequence(mix: Map<Cls, number>, n: number | null): Array<{ cls: Cls; text: string }> {
  const counts = new Map(mix);
  const mixTotal = [...counts.values()].reduce((a, b) => a + b, 0);
  if (n !== null && n !== mixTotal) {
    let assigned = 0;
    const classes = [...counts.keys()];
    for (const cls of classes) {
      const scaled = Math.round((counts.get(cls)! / mixTotal) * n);
      counts.set(cls, scaled);
      assigned += scaled;
    }
    counts.set(classes[0]!, counts.get(classes[0]!)! + (n - assigned));
  }
  const remaining = new Map(counts);
  const nextIdx = new Map<Cls, number>();
  const seq: Array<{ cls: Cls; text: string }> = [];
  const total = [...remaining.values()].reduce((a, b) => a + b, 0);
  for (let i = 0; i < total; i++) {
    let pick: Cls | null = null;
    let best = -1;
    for (const [cls, left] of remaining) {
      const ratio = left / Math.max(1, counts.get(cls)!);
      if (left > 0 && ratio > best) {
        best = ratio;
        pick = cls;
      }
    }
    if (!pick) break;
    const bank = BANKS[pick];
    const idx = nextIdx.get(pick) ?? 0;
    seq.push({ cls: pick, text: bank[idx % bank.length]! });
    nextIdx.set(pick, idx + 1);
    remaining.set(pick, remaining.get(pick)! - 1);
  }
  return seq;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}

function csvQuote(value: unknown): string {
  const s = value === undefined || value === null ? '' : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

interface Row {
  index: number;
  cls: Cls;
  request_id: string;
  http_status: number | '';
  status: string;
  queued_ms: number | '';
  answered_ms: number | '';
  waited_ms: number | '';
  client_ms: number;
  question: string;
  reply_preview: string;
}

interface AskResponse {
  ok?: boolean;
  status?: string;
  reason?: string;
  error?: string;
  reply?: { body?: string };
  timing?: { queued_ms?: number; answered_ms?: number; waited_ms?: number };
}

const sequence = buildSequence(parseMix(mixArg), nOverride);
console.log(`siri-probe → ${base}  asks=${sequence.length}  wait=${waitMs}ms  pause=${pauseMs}ms`);
console.log(`csv → ${csvPath}\n`);

const rows: Row[] = [];
for (let i = 0; i < sequence.length; i++) {
  const { cls, text } = sequence[i]!;
  const requestId = randomUUID();
  const started = Date.now();
  let httpStatus: number | '' = '';
  let json: AskResponse | null = null;
  let status = 'error';
  try {
    const res = await fetch(`${base}/api/v1/siri/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        text,
        wait_ms: waitMs,
        request_id: requestId,
        client: { device: 'probe', app_version: 'siri-probe', locale: 'en_US' },
      }),
      signal: AbortSignal.timeout(waitMs + 15000),
    });
    httpStatus = res.status;
    json = (await res.json().catch(() => null)) as AskResponse | null;
    if (res.status === 401) {
      console.error('401 Unauthorized — the token does not match any contacts.*.platforms.siri.token. Aborting.');
      process.exit(1);
    }
    status = json?.status ?? json?.reason ?? json?.error ?? `http_${res.status}`;
  } catch (err) {
    status = `unreachable: ${String(err)}`;
  }
  const clientMs = Date.now() - started;
  const row: Row = {
    index: i + 1,
    cls,
    request_id: requestId,
    http_status: httpStatus,
    status,
    queued_ms: json?.timing?.queued_ms ?? '',
    answered_ms: json?.timing?.answered_ms ?? '',
    waited_ms: json?.timing?.waited_ms ?? '',
    client_ms: clientMs,
    question: text,
    reply_preview: preview(json?.reply?.body ?? ''),
  };
  rows.push(row);

  const label = `#${String(row.index).padStart(2, '0')} ${cls.padEnd(7)}`;
  if (status === 'answered') {
    console.log(`${label} queued=${row.queued_ms}ms answered=${row.answered_ms}ms  "${row.reply_preview}"`);
  } else if (status === 'pending') {
    console.log(`${label} queued=${row.queued_ms}ms TIMEOUT waited=${row.waited_ms}ms`);
  } else {
    console.log(`${label} ERROR ${httpStatus} ${status} (client ${clientMs}ms)`);
  }

  if (i < sequence.length - 1) await new Promise((r) => setTimeout(r, pauseMs));
}

function summarize(label: string, subset: Row[]): void {
  const answered = subset.filter((r) => r.status === 'answered').map((r) => r.answered_ms as number).sort((a, b) => a - b);
  const timeouts = subset.filter((r) => r.status === 'pending').length;
  const errors = subset.length - answered.length - timeouts;
  const fmt = (v: number) => (Number.isNaN(v) ? '-' : `${Math.round(v)}ms`);
  console.log(
    `${label.padEnd(8)} n=${subset.length} answered=${answered.length} timeouts=${timeouts} errors=${errors}` +
      `  p50=${fmt(percentile(answered, 50))} p95=${fmt(percentile(answered, 95))} max=${fmt(answered.at(-1) ?? NaN)}`,
  );
}

console.log('');
for (const cls of ['trivial', 'memory', 'tool'] as Cls[]) {
  const subset = rows.filter((r) => r.cls === cls);
  if (subset.length > 0) summarize(cls, subset);
}
summarize('overall', rows);

const header = [
  'index', 'class', 'request_id', 'http_status', 'status', 'queued_ms', 'answered_ms', 'waited_ms', 'client_ms', 'question', 'reply_preview',
];
const csv = [header.join(',')]
  .concat(rows.map((r) => header.map((h) => csvQuote((r as unknown as Record<string, unknown>)[h])).join(',')))
  .join('\n');
mkdirSync(dirname(csvPath), { recursive: true });
writeFileSync(csvPath, `${csv}\n`);
console.log(`\nwrote ${rows.length} rows → ${csvPath}`);
