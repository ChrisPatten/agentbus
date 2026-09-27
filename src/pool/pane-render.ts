/**
 * Renders a captured tmux pane screen (text with ANSI SGR colors) to a PNG.
 *
 * Pipeline: parse SGR escapes into per-cell styles -> emit an SVG (one
 * background rect and one <text> per same-style run) -> rasterize with
 * `@resvg/resvg-js` (prebuilt native binary, no node-gyp build, no headless
 * browser). Image size is derived from the pane's real `cols` x `rows`, not
 * from the text, so a mostly-empty pane still renders at its true size.
 *
 * Pure and I/O-free apart from the resvg call; the capture itself lives in
 * `src/pool/tmux.ts`. Only SGR (`ESC [ ... m`) is interpreted — every other
 * CSI/OSC sequence is dropped, since `capture-pane -e` emits a rendered
 * screen, not a cursor-movement stream.
 */
import { Resvg } from '@resvg/resvg-js';

/** Layout constants (px). Cell width tracks Menlo/DejaVu Sans Mono at 14px. */
const FONT_SIZE = 14;
const CELL_W = 8.4;
const CELL_H = 18;
const PAD = 8;
const FONT_FAMILY = "Menlo, 'SF Mono', Monaco, 'DejaVu Sans Mono', 'Liberation Mono', Consolas, monospace";

/** Upper bounds so a pathological pane size can't produce an oversized image (Telegram caps width+height at 10000px). */
export const MAX_COLS = 400;
export const MAX_ROWS = 150;

const DEFAULT_FG = '#d4d4d4';
const DEFAULT_BG = '#1e1e1e';

const ANSI_16 = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
];

interface Style {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  reverse: boolean;
}

interface Cell {
  ch: string;
  /** Columns this cell occupies (2 for wide CJK/emoji glyphs). */
  width: number;
  style: Style;
}

const BLANK_STYLE: Style = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, reverse: false };

function color256(n: number): string {
  if (n < 16) return ANSI_16[n]!;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const level = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${level(Math.floor(i / 36))},${level(Math.floor(i / 6) % 6)},${level(i % 6)})`;
}

/** Apply one SGR parameter list (the part between `ESC[` and `m`) to `style`. */
function applySgr(style: Style, params: number[]): Style {
  const s = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (p === 0) Object.assign(s, BLANK_STYLE);
    else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 7) s.reverse = true;
    else if (p === 22) { s.bold = false; s.dim = false; }
    else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if (p === 27) s.reverse = false;
    else if (p >= 30 && p <= 37) s.fg = ANSI_16[p - 30]!;
    else if (p >= 90 && p <= 97) s.fg = ANSI_16[p - 90 + 8]!;
    else if (p >= 40 && p <= 47) s.bg = ANSI_16[p - 40]!;
    else if (p >= 100 && p <= 107) s.bg = ANSI_16[p - 100 + 8]!;
    else if (p === 39) s.fg = null;
    else if (p === 49) s.bg = null;
    else if (p === 38 || p === 48) {
      const target = p === 38 ? 'fg' : 'bg';
      if (params[i + 1] === 5 && params[i + 2] !== undefined) {
        s[target] = color256(Math.max(0, Math.min(255, params[i + 2]!)));
        i += 2;
      } else if (params[i + 1] === 2 && params[i + 4] !== undefined) {
        const [r, g, b] = [params[i + 2]!, params[i + 3]!, params[i + 4]!].map((v) => Math.max(0, Math.min(255, v)));
        s[target] = `rgb(${r},${g},${b})`;
        i += 4;
      }
    }
  }
  return s;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

// CSI: ESC [ params intermediates final. OSC: ESC ] ... (BEL | ESC \). Other two-byte escapes: ESC <char>.
const ESCAPE_RE = /\x1b\[([0-9;:]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/y;

/** Parse ANSI text into rows of styled cells (SGR state carries across rows, as in a real terminal). */
export function parseAnsi(text: string): Cell[][] {
  const rows: Cell[][] = [];
  let style = BLANK_STYLE;
  for (const line of text.split('\n')) {
    const row: Cell[] = [];
    let i = 0;
    while (i < line.length) {
      if (line.charCodeAt(i) === 0x1b) {
        ESCAPE_RE.lastIndex = i;
        const m = ESCAPE_RE.exec(line);
        if (!m) { i++; continue; }
        if (m[2] === 'm') {
          const params = (m[1] ?? '').split(/[;:]/).map((x) => (x === '' ? 0 : Number(x)));
          style = applySgr(style, params);
        }
        i += m[0].length;
        continue;
      }
      const cp = line.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      i += ch.length;
      if (cp < 0x20 || cp === 0x7f) continue;
      row.push({ ch, width: isWide(cp) ? 2 : 1, style });
    }
    rows.push(row);
  }
  return rows;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function resolveColors(style: Style): { fg: string; bg: string | null } {
  let fg = style.fg ?? DEFAULT_FG;
  let bg = style.bg;
  if (style.reverse) {
    const swappedBg = fg;
    fg = bg ?? DEFAULT_BG;
    bg = swappedBg;
  }
  return { fg, bg };
}

/** Pixel size of the PNG that `renderPanePng` produces for a `cols` x `rows` pane. */
export function paneImageSize(cols: number, rows: number): { width: number; height: number } {
  const c = Math.min(cols, MAX_COLS);
  const r = Math.min(rows, MAX_ROWS);
  return { width: Math.ceil(c * CELL_W + PAD * 2), height: Math.ceil(r * CELL_H + PAD * 2) };
}

/** Build the SVG document for a captured screen. Exported for tests. */
export function renderPaneSvg(text: string, cols: number, rows: number): string {
  const c = Math.min(cols, MAX_COLS);
  const r = Math.min(rows, MAX_ROWS);
  const { width, height } = paneImageSize(cols, rows);
  const parsed = parseAnsi(text).slice(0, r);

  const rects: string[] = [];
  const texts: string[] = [];

  parsed.forEach((row, rowIdx) => {
    const y = PAD + rowIdx * CELL_H;
    // Group consecutive cells with identical rendered style into runs.
    let col = 0;
    let runStart = 0;
    let runText = '';
    let runStyle: Style | null = null;

    const flush = (endCol: number) => {
      if (!runStyle || endCol <= runStart) return;
      const { fg, bg } = resolveColors(runStyle);
      const x = PAD + runStart * CELL_W;
      const w = (endCol - runStart) * CELL_W;
      if (bg) rects.push(`<rect x="${x.toFixed(2)}" y="${y}" width="${w.toFixed(2)}" height="${CELL_H}" fill="${bg}"/>`);
      if (runText.trim().length > 0 || runStyle.underline) {
        const attrs = [
          `x="${x.toFixed(2)}"`,
          `y="${y + CELL_H - 5}"`,
          `fill="${fg}"`,
          `textLength="${w.toFixed(2)}"`,
          `lengthAdjust="spacing"`,
          runStyle.bold ? 'font-weight="bold"' : '',
          runStyle.italic ? 'font-style="italic"' : '',
          runStyle.dim ? 'opacity="0.6"' : '',
          runStyle.underline ? 'text-decoration="underline"' : '',
        ].filter(Boolean);
        texts.push(`<text ${attrs.join(' ')} xml:space="preserve">${escapeXml(runText)}</text>`);
      }
    };

    for (const cell of row) {
      if (col >= c) break;
      if (!runStyle || !sameStyle(runStyle, cell.style)) {
        flush(col);
        runStart = col;
        runText = '';
        runStyle = cell.style;
      }
      runText += cell.ch;
      col += cell.width;
    }
    flush(Math.min(col, c));
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${DEFAULT_BG}"/>`,
    `<g font-family="${escapeXml(FONT_FAMILY)}" font-size="${FONT_SIZE}">`,
    ...rects,
    ...texts,
    '</g>',
    '</svg>',
  ].join('\n');
}

function sameStyle(a: Style, b: Style): boolean {
  return (
    a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim &&
    a.italic === b.italic && a.underline === b.underline && a.reverse === b.reverse
  );
}

/** Render a captured pane screen to a PNG sized to its real `cols` x `rows`. */
export function renderPanePng(text: string, cols: number, rows: number): Buffer {
  const svg = renderPaneSvg(text, cols, rows);
  const resvg = new Resvg(svg, {
    font: { loadSystemFonts: true, defaultFontFamily: 'Menlo' },
  });
  return Buffer.from(resvg.render().asPng());
}

/** Strip ANSI escapes — used for the plain-text fallback on channels without image support. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;:]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '');
}
