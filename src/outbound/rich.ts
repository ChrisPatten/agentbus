/**
 * S81.9 — rich message helpers (E81): the plain-text fallback and size
 * handling for `send_rich`.
 *
 * Telegram renders Rich Markdown / HTML natively (tables, collapsible
 * `<details>`, button rows). Every other channel, and Telegram itself when
 * the rich call is rejected, gets a plain-text body. Tables become `label:
 * value` lists, never markdown tables (Chris's standing preference).
 */

/** Telegram's limit for a rich message (UTF-8 characters, verified live in the S81.1 spike). */
export const RICH_MAX_CHARS = 32768;
/** Chunk budget: leaves room for the part marker under the platform limit. */
export const RICH_CHUNK_CHARS = 30000;

export type RichFormat = 'markdown' | 'html';

const TRUNCATION_MARKER = '… [truncated: message too long]';

// ── Plain-text fallback ──────────────────────────────────────────────────────

function stripInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_m, alt: string, url: string, cap: string | undefined) => {
      const label = cap || alt;
      return label ? `${label}: ${url}` : url;
    })
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/==([^=]+)==/g, '$1')
    .replace(/\|\|([^|]+)\|\|/g, '$1')
    .replace(/<\/?(?:u|ins|sub|sup|b|i|em|strong|s|del|code|mark|tg-spoiler|cite|aside)\b[^>]*>/gi, '')
    .replace(/\s+$/g, '');
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => stripInline(c.trim()));
}

function isSeparatorRow(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
}

/** One table (header + rows) as a `label: value` list. */
function tableToList(header: string[], rows: string[][]): string[] {
  return rows.map((row) => {
    if (header.length <= 2 && row.length >= 2) return `- ${row[0]}: ${row.slice(1).join(' ')}`;
    const [first, ...rest] = row;
    const extras = rest.map((cell, i) => `${header[i + 1] ?? `col${i + 2}`}: ${cell}`).join(', ');
    return extras ? `- ${first} (${extras})` : `- ${first}`;
  });
}

function buttonsToLines(fragment: string): string[] {
  const lines: string[] = [];
  const re = /<tg-button(?![-\w])([^>]*)>([\s\S]*?)<\/tg-button>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) {
    const attrs = m[1] ?? '';
    const label = stripInline((m[2] ?? '').replace(/<[^>]+>/g, '').trim());
    const url = /\burl="([^"]*)"/.exec(attrs)?.[1];
    const copy = /\btext="([^"]*)"/.exec(attrs)?.[1];
    lines.push(url ? `- ${label}: ${url}` : copy ? `- ${label}: ${copy}` : `- ${label}`);
  }
  return lines;
}

function markdownToPlain(md: string): string {
  const out: string[] = [];
  const lines = md.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    // Table: a pipe row immediately followed by a separator row.
    if (line.trim().startsWith('|') && i + 1 < lines.length && isSeparatorRow(lines[i + 1]!)) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      i--;
      out.push(...tableToList(header, rows));
      continue;
    }
    if (/<tg-button(?![-\w])/i.test(line)) {
      const buttonLines = buttonsToLines(line);
      // Multi-line button rows: gather until the closing row tag.
      let joined = line;
      while (!/<\/tg-button-row>|<\/p>/i.test(joined) && i + 1 < lines.length && /tg-button|<\/p>/i.test(lines[i + 1]!)) {
        i++;
        joined += lines[i]!;
      }
      out.push(...(joined === line ? buttonLines : buttonsToLines(joined)));
      continue;
    }
    const details = /^\s*<details\b[^>]*>\s*(?:<summary>([\s\S]*?)<\/summary>)?\s*$/i.exec(line);
    if (details) {
      if (details[1]) out.push(`${stripInline(details[1])}:`);
      else if (/<summary>/i.test(lines[i + 1] ?? '')) {
        const sum = /<summary>([\s\S]*?)<\/summary>/i.exec(lines[i + 1]!);
        if (sum) out.push(`${stripInline(sum[1]!)}:`);
        i++;
      }
      continue;
    }
    if (/^\s*<\/details>\s*$/i.test(line)) continue;
    const inlineDetails = /^\s*<details\b[^>]*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>\s*$/i.exec(line);
    if (inlineDetails) {
      out.push(`${stripInline(inlineDetails[1]!)}: ${stripInline(inlineDetails[2]!.trim())}`);
      continue;
    }
    out.push(stripInline(line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s*>\s?/, '')));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function htmlToPlain(html: string): string {
  let text = html.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_m, inner: string) => {
    const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
      [...(r[1] ?? '').matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => (c[1] ?? '').replace(/<[^>]+>/g, '').trim()),
    );
    if (rows.length === 0) return '';
    const hasHeader = /<th\b/i.test(inner);
    const header = hasHeader ? rows[0]! : [];
    const body = hasHeader ? rows.slice(1) : rows;
    return `\n${tableToList(header, body).join('\n')}\n`;
  });
  text = text
    .replace(/<tg-button-row\b[^>]*>([\s\S]*?)<\/tg-button-row>/gi, (_m, inner: string) => `\n${buttonsToLines(inner).join('\n')}\n`)
    .replace(/<summary>([\s\S]*?)<\/summary>/gi, '\n$1:\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|details|ul|ol|blockquote|footer|pre)>/gi, '\n')
    .replace(/<(p|div|h[1-6]|details|ul|ol|blockquote|footer|pre)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Plain-text rendering of rich content: no markdown tables, collapsibles flattened, buttons listed. */
export function renderRichPlain(content: string, format: RichFormat): string {
  return format === 'html' ? htmlToPlain(content) : markdownToPlain(content);
}

// ── Size handling ────────────────────────────────────────────────────────────

/**
 * Splits `content` into chunks of at most `maxChars` characters. Markdown is
 * split only at blank lines outside code fences and `<details>` blocks, so a
 * table or collapsible section is never cut in half; a single block larger than
 * the budget is truncated with a marker. HTML content cannot be split safely, so
 * an oversize HTML message is truncated. With more than one chunk each gets a
 * trailing "(part i of n)" line.
 */
export function splitRichContent(content: string, format: RichFormat, maxChars: number = RICH_CHUNK_CHARS): string[] {
  if (content.length <= maxChars) return [content];

  const truncate = (text: string): string => `${text.slice(0, maxChars - TRUNCATION_MARKER.length - 2)}\n\n${TRUNCATION_MARKER}`;
  if (format === 'html') return [truncate(content)];

  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let detailsDepth = 0;
  for (const line of content.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence) {
      detailsDepth += (line.match(/<details\b/gi) ?? []).length;
      detailsDepth -= (line.match(/<\/details>/gi) ?? []).length;
    }
    if (line.trim() === '' && !inFence && detailsDepth <= 0) {
      if (current.length > 0) blocks.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current.join('\n'));

  const chunks: string[] = [];
  let buf = '';
  for (let block of blocks) {
    if (block.length > maxChars) block = truncate(block);
    if (buf && buf.length + 2 + block.length > maxChars) {
      chunks.push(buf);
      buf = block;
    } else {
      buf = buf ? `${buf}\n\n${block}` : block;
    }
  }
  if (buf) chunks.push(buf);
  if (chunks.length === 1) return chunks;
  return chunks.map((c, i) => `${c}\n\n_(part ${i + 1} of ${chunks.length})_`);
}
