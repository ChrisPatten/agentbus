import { describe, it, expect } from 'vitest';
import { renderPanePng, renderPaneSvg, paneImageSize, parseAnsi, stripAnsi, MAX_COLS, MAX_ROWS } from './pane-render.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngDimensions(png: Buffer): { width: number; height: number } {
  // IHDR is the first chunk: 8-byte signature, 4-byte length, "IHDR", then width/height as big-endian u32.
  expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe('renderPanePng', () => {
  it('produces a valid PNG sized to the pane\'s cols x rows', () => {
    const png = renderPanePng('\x1b[1;32mhello\x1b[0m world\nsecond line', 80, 24);
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(pngDimensions(png)).toEqual(paneImageSize(80, 24));
  });

  it('sizes an empty pane by its real dimensions, not its text', () => {
    const png = renderPanePng('', 120, 40);
    expect(pngDimensions(png)).toEqual(paneImageSize(120, 40));
    expect(paneImageSize(120, 40).width).toBeGreaterThan(paneImageSize(80, 24).width);
  });

  it('clamps an absurd pane size so the image stays deliverable', () => {
    const { width, height } = paneImageSize(5000, 5000);
    expect(width).toBe(paneImageSize(MAX_COLS, MAX_ROWS).width);
    expect(height).toBe(paneImageSize(MAX_COLS, MAX_ROWS).height);
    expect(width + height).toBeLessThan(10000);
  });

  it('does not throw on malformed or unsupported escape sequences', () => {
    const text = 'a\x1b[999;38;5mb\x1b]0;title\x07c\x1b[2Jd\x1b[38;2;1;2m\x1b';
    expect(() => renderPanePng(text, 40, 5)).not.toThrow();
  });
});

describe('parseAnsi', () => {
  it('applies SGR foreground/background/bold and resets', () => {
    const [row] = parseAnsi('\x1b[1;31;44mA\x1b[0mB');
    expect(row![0]!.style).toMatchObject({ bold: true, fg: '#cd3131', bg: '#2472c8' });
    expect(row![1]!.style).toMatchObject({ bold: false, fg: null, bg: null });
  });

  it('supports 256-color and truecolor', () => {
    const [row] = parseAnsi('\x1b[38;5;196mA\x1b[48;2;10;20;30mB');
    expect(row![0]!.style.fg).toBe('rgb(255,0,0)');
    expect(row![1]!.style.bg).toBe('rgb(10,20,30)');
  });

  it('carries SGR state across rows and counts wide glyphs as two columns', () => {
    const rows = parseAnsi('\x1b[31ma\n日');
    expect(rows[1]![0]).toMatchObject({ ch: '日', width: 2 });
    expect(parseAnsi('\x1b[31ma\nb')[1]![0]!.style.fg).toBe('#cd3131');
  });
});

describe('renderPaneSvg', () => {
  it('escapes XML-significant characters in pane text', () => {
    const svg = renderPaneSvg('<b> & "q"', 20, 2);
    expect(svg).toContain('&lt;b&gt; &amp; &quot;q&quot;');
    expect(svg).not.toContain('<b>');
  });

  it('emits a background rect only for cells with a background color', () => {
    expect(renderPaneSvg('plain', 20, 2).match(/<rect /g)).toHaveLength(1); // the page background
    expect(renderPaneSvg('\x1b[41mred\x1b[0m', 20, 2).match(/<rect /g)).toHaveLength(2);
  });
});

describe('stripAnsi', () => {
  it('removes SGR and OSC sequences, leaving the text', () => {
    expect(stripAnsi('\x1b[1;32mok\x1b[0m \x1b]0;t\x07done')).toBe('ok done');
  });
});
