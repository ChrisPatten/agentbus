import { describe, expect, it } from 'vitest';
import { clampGlance, deriveGlance, GLANCE_MAX, resolveGlance, stripMarkdown, surfaceBody, truncateAtWord } from './glance.js';

describe('stripMarkdown', () => {
  it('removes formatting but keeps line breaks and turns bullets into dots', () => {
    const md = '# Title\n\n**Bold** and _italic_ with `code` and [a link](https://x.test).\n\n- one\n- two\n\n```js\nlet a = 1;\n```';
    expect(stripMarkdown(md)).toBe('Title\n\nBold and italic with code and a link.\n\n• one\n• two\n\nlet a = 1;');
  });
  it('leaves snake_case and math alone', () => {
    expect(stripMarkdown('use my_var_name and 2*3*4')).toBe('use my_var_name and 2*3*4');
  });
});

describe('truncateAtWord', () => {
  it('cuts at a word boundary with an ellipsis, within the limit', () => {
    const out = truncateAtWord('alpha beta gamma delta epsilon', 16);
    expect(out).toBe('alpha beta…');
    expect(Array.from(out).length).toBeLessThanOrEqual(16);
  });
  it('returns short text unchanged', () => {
    expect(truncateAtWord('short', 10)).toBe('short');
  });
});

describe('glance', () => {
  it('truncates an over-long agent glance to 100 characters instead of rejecting it', () => {
    const long = 'word '.repeat(60);
    const out = clampGlance(long)!;
    expect(Array.from(out).length).toBeLessThanOrEqual(GLANCE_MAX);
    expect(out.endsWith('…')).toBe(true);
  });
  it('keeps a good glance, strips markdown, and rejects non-strings and blanks', () => {
    expect(clampGlance('**Dentist** at 3')).toBe('Dentist at 3');
    expect(clampGlance('   ')).toBeNull();
    expect(clampGlance(42)).toBeNull();
  });
  it('derives from the first sentence of the body, markdown stripped', () => {
    expect(deriveGlance('**Very good**, Mr. Patten. Your 2 o\'clock is moved.\nMore text.')).toBe('Very good, Mr. Patten.');
  });
  it('derives a 100 character line on a word boundary with an ellipsis', () => {
    const body = 'This is a very long single sentence without any stop that keeps on going for quite a while and then some more words after it';
    const out = deriveGlance(body);
    expect(Array.from(out).length).toBeLessThanOrEqual(GLANCE_MAX);
    expect(out.endsWith('…')).toBe(true);
    expect(body.startsWith(out.slice(0, -1))).toBe(true);
  });
  it('prefers the agent glance, falls back to derived', () => {
    expect(resolveGlance('Moved to 4', 'Long body here. More.')).toBe('Moved to 4');
    expect(resolveGlance(undefined, 'Long body here. More.')).toBe('Long body here.');
  });
});

describe('surfaceBody', () => {
  it('cuts bodies over 1,200 characters at a word boundary and reports it', () => {
    const { text, cut } = surfaceBody('lorem ipsum '.repeat(200));
    expect(cut).toBe(true);
    expect(Array.from(text).length).toBeLessThanOrEqual(1200);
    expect(text.endsWith('…')).toBe(true);
  });
  it('passes short bodies through', () => {
    expect(surfaceBody('Hello **there**')).toEqual({ text: 'Hello there', cut: false });
  });
});
