/**
 * Line diffs for self-edit proposals (E68 S68.3): a compact unified diff to
 * show owners, and a strict unified-diff applier for proposals sent as a
 * `diff`. No dependencies; sized for instruction files (hundreds of lines).
 */

const splitLines = (text: string): string[] => {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

type Op = { kind: ' ' | '-' | '+'; line: string; a: number; b: number };

/** Edit script between two line arrays (LCS). Null when the inputs are too large to compare cheaply. */
function editScript(a: string[], b: string[], maxCells = 4_000_000): Op[] | null {
  // Trim the common prefix and suffix first: most proposals change a few lines.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start;
  const m = endB - start;
  if (n * m > maxCells) return null;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[start + i] === b[start + j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  for (let k = 0; k < start; k++) ops.push({ kind: ' ', line: a[k]!, a: k, b: k });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      ops.push({ kind: ' ', line: a[start + i]!, a: start + i, b: start + j }); i++; j++;
    } else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      // Deletions before insertions, as diff(1) shows them.
      ops.push({ kind: '-', line: a[start + i]!, a: start + i, b: start + j }); i++;
    } else {
      ops.push({ kind: '+', line: b[start + j]!, a: start + i, b: start + j }); j++;
    }
  }
  for (let k = 0; k < a.length - endA; k++) ops.push({ kind: ' ', line: a[endA + k]!, a: endA + k, b: endB + k });
  return ops;
}

/**
 * A unified diff of `before` → `after` with `context` lines around each
 * change, cut at `maxChars` (marked). `before` null means a new file.
 */
export function compactDiff(before: string | null, after: string, opts: { context?: number; maxChars?: number; label?: string } = {}): string {
  const context = opts.context ?? 2;
  const maxChars = opts.maxChars ?? 1800;
  const a = splitLines(before ?? '');
  const b = splitLines(after);
  const ops = editScript(a, b);
  const header = opts.label ? [`--- ${before === null ? '/dev/null' : `a/${opts.label}`}`, `+++ b/${opts.label}`] : [];
  if (!ops) return [...header, `(file too large to diff: ${a.length} → ${b.length} lines)`].join('\n');
  const changed = ops.map((op, idx) => (op.kind === ' ' ? -1 : idx)).filter((idx) => idx >= 0);
  if (changed.length === 0) return [...header, '(no changes)'].join('\n');

  // Group changes into hunks with their context.
  const hunks: Array<[number, number]> = [];
  for (const idx of changed) {
    const from = Math.max(0, idx - context);
    const to = Math.min(ops.length - 1, idx + context);
    const last = hunks[hunks.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else hunks.push([from, to]);
  }
  const out = [...header];
  for (const [from, to] of hunks) {
    const slice = ops.slice(from, to + 1);
    const aStart = slice.find((o) => o.kind !== '+')?.a ?? slice[0]!.a;
    const bStart = slice.find((o) => o.kind !== '-')?.b ?? slice[0]!.b;
    const aLen = slice.filter((o) => o.kind !== '+').length;
    const bLen = slice.filter((o) => o.kind !== '-').length;
    out.push(`@@ -${aLen === 0 ? aStart : aStart + 1},${aLen} +${bLen === 0 ? bStart : bStart + 1},${bLen} @@`);
    for (const o of slice) out.push(`${o.kind}${o.line}`);
  }
  let text = out.join('\n');
  if (text.length > maxChars) {
    const cut = text.lastIndexOf('\n', maxChars);
    const shown = text.slice(0, cut > 0 ? cut : maxChars);
    const remaining = text.slice(shown.length).split('\n').filter((l) => /^[-+](?![-+]{2} )/.test(l)).length;
    text = `${shown}\n… (${remaining} more changed line${remaining === 1 ? '' : 's'} not shown)`;
  }
  return text;
}

/** Thrown by `applyUnifiedDiff` when a hunk doesn't match the current file. */
export class DiffApplyError extends Error {}

/**
 * Apply a unified diff (`@@ -a,b +c,d @@` hunks; `---`/`+++` headers and
 * `\ No newline` markers ignored) to `text`. Each hunk's context and removed
 * lines must match exactly; a hunk may sit up to 50 lines from its stated
 * position. Hunks apply in order.
 */
export function applyUnifiedDiff(text: string, diff: string): string {
  const lines = splitLines(text);
  const trailingNewline = text === '' || text.endsWith('\n');
  const diffLines = diff.replace(/\r\n/g, '\n').split('\n');
  const hunks: Array<{ start: number; old: string[]; neu: string[] }> = [];
  for (let i = 0; i < diffLines.length; i++) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(diffLines[i]!);
    if (!header) continue; // preamble, ---/+++ headers
    let oldLeft = header[2] === undefined ? 1 : Number(header[2]);
    let newLeft = header[4] === undefined ? 1 : Number(header[4]);
    const hunk = { start: Math.max(0, Number(header[1]) - (oldLeft === 0 ? 0 : 1)), old: [] as string[], neu: [] as string[] };
    hunks.push(hunk);
    while ((oldLeft > 0 || newLeft > 0) && i + 1 < diffLines.length) {
      const raw = diffLines[++i]!;
      if (raw.startsWith('\\')) continue;
      const kind = raw === '' ? ' ' : raw[0];
      const body = raw.slice(1);
      if (kind === ' ') { hunk.old.push(body); hunk.neu.push(body); oldLeft--; newLeft--; }
      else if (kind === '-') { hunk.old.push(body); oldLeft--; }
      else if (kind === '+') { hunk.neu.push(body); newLeft--; }
      else throw new DiffApplyError(`unexpected diff line: ${raw.slice(0, 60)}`);
    }
    if (oldLeft > 0 || newLeft > 0) throw new DiffApplyError('diff ends inside a hunk');
  }
  if (hunks.length === 0) throw new DiffApplyError('no hunks in diff');

  const out: string[] = [];
  let cursor = 0;
  for (const [n, h] of hunks.entries()) {
    const matches = (at: number) => at >= cursor && at + h.old.length <= lines.length && h.old.every((l, k) => lines[at + k] === l);
    let at = -1;
    for (let delta = 0; delta <= 50 && at < 0; delta++) {
      if (matches(h.start + delta)) at = h.start + delta;
      else if (delta > 0 && matches(h.start - delta)) at = h.start - delta;
    }
    if (at < 0) throw new DiffApplyError(`hunk ${n + 1} does not match the current file`);
    out.push(...lines.slice(cursor, at), ...h.neu);
    cursor = at + h.old.length;
  }
  out.push(...lines.slice(cursor));
  return out.length === 0 ? '' : `${out.join('\n')}${trailingNewline ? '\n' : ''}`;
}
