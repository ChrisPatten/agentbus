import { describe, it, expect } from 'vitest';
import { renderRichPlain, splitRichContent, RICH_CHUNK_CHARS } from './rich.js';

const BRIEF = `# Morning brief

| Item | Time |
|:--|--:|
| Dentist | 10:00 |
| ENT | 2:50 PM |

<details><summary>Calendar</summary>

- Dentist
- ENT

</details>

<tg-button-row align="left"><tg-button type="url" url="https://example.com">Open</tg-button><tg-button type="copy_text" text="1234">Copy code</tg-button></tg-button-row>`;

describe('renderRichPlain (S81.9)', () => {
  it('renders a morning-brief-shaped message with no markdown table', () => {
    const plain = renderRichPlain(BRIEF, 'markdown');
    expect(plain).not.toMatch(/\|/);
    expect(plain).not.toMatch(/^#/m);
    expect(plain).toContain('Morning brief');
    expect(plain).toContain('- Dentist: 10:00');
    expect(plain).toContain('- ENT: 2:50 PM');
    expect(plain).toContain('Calendar:');
    expect(plain).toContain('- Open: https://example.com');
    expect(plain).toContain('- Copy code: 1234');
    expect(plain).not.toContain('<');
  });

  it('turns a three-column table into labelled lists', () => {
    const plain = renderRichPlain('| Name | Qty | Price |\n|--|--|--|\n| Tea | 2 | $4 |', 'markdown');
    expect(plain).toBe('- Tea (Qty: 2, Price: $4)');
  });

  it('strips emphasis markers, links and images', () => {
    const plain = renderRichPlain('**bold** and [a link](https://x.io) ![](https://x.io/p.jpg "A photo")', 'markdown');
    expect(plain).toBe('bold and a link (https://x.io) A photo: https://x.io/p.jpg');
  });

  it('flattens a single-line details block', () => {
    expect(renderRichPlain('<details><summary>More</summary>Hidden text</details>', 'markdown')).toBe('More: Hidden text');
  });

  it('keeps code fence content', () => {
    expect(renderRichPlain('```\nx = 1\n```', 'markdown')).toBe('x = 1');
  });

  it('renders html tables, details and buttons as plain text', () => {
    const plain = renderRichPlain(
      '<h2>Plan</h2><table><tr><th>Item</th><th>When</th></tr><tr><td>Dentist</td><td>10:00</td></tr></table>' +
        '<details><summary>Notes</summary><p>Bring card</p></details>' +
        '<tg-button-row><tg-button type="url" url="https://e.com">Go</tg-button></tg-button-row>',
      'html',
    );
    expect(plain).toContain('Plan');
    expect(plain).toContain('- Dentist: 10:00');
    expect(plain).toContain('Notes:');
    expect(plain).toContain('Bring card');
    expect(plain).toContain('- Go: https://e.com');
    expect(plain).not.toContain('<');
  });
});

describe('splitRichContent (S81.9)', () => {
  it('returns one chunk when the content fits', () => {
    expect(splitRichContent('short', 'markdown')).toEqual(['short']);
  });

  it('splits at blank lines into predictable chunks with part markers', () => {
    const para = 'x'.repeat(40);
    const content = Array.from({ length: 6 }, () => para).join('\n\n');
    const chunks = splitRichContent(content, 'markdown', 100);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe(`${para}\n\n${para}\n\n_(part 1 of 3)_`);
    expect(chunks[2]).toContain('_(part 3 of 3)_');
    expect(splitRichContent(content, 'markdown', 100)).toEqual(chunks);
  });

  it('never splits inside a details block or a code fence', () => {
    const details = '<details><summary>S</summary>\n\nline a\n\nline b\n\n</details>';
    const fence = '```\nline\n\nline\n```';
    const content = [`${'p'.repeat(60)}`, details, fence].join('\n\n');
    const chunks = splitRichContent(content, 'markdown', 90);
    const withDetails = chunks.find((c) => c.includes('<details>'))!;
    expect(withDetails).toContain('</details>');
    const withFence = chunks.find((c) => c.includes('```'))!;
    expect(withFence.match(/```/g)).toHaveLength(2);
  });

  it('truncates a single block larger than the budget with a marker', () => {
    const chunks = splitRichContent('y'.repeat(500), 'markdown', 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.length).toBeLessThanOrEqual(100);
    expect(chunks[0]).toContain('[truncated: message too long]');
  });

  it('truncates oversize html', () => {
    const chunks = splitRichContent(`<p>${'z'.repeat(200)}</p>`, 'html', 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('[truncated');
  });

  it('keeps the default chunk budget under the platform limit', () => {
    expect(RICH_CHUNK_CHARS).toBeLessThan(32768);
  });
});
