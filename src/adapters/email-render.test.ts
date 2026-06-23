import { describe, it, expect } from 'vitest';
import { renderEmail, htmlToPlainText } from './email-render.js';

describe('renderEmail', () => {
  it('returns the original markdown as the plain-text part', () => {
    const md = '# Hi\n\nA **bold** line.';
    expect(renderEmail(md).text).toBe(md);
  });

  it('wraps output in a responsive, dark-mode-aware HTML document', () => {
    const { html } = renderEmail('hello');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('width=device-width');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('x-apple-disable-message-reformatting');
    // body content present and inside the styled card
    expect(html).toContain('email-card');
    expect(html).toContain('hello');
  });

  it('renders a GFM table with inline cell borders, a header, and zebra rows', () => {
    const { html } = renderEmail('| Name | Qty |\n|---|---|\n| Apples | 3 |\n| Pears | 5 |');
    expect(html).toContain('<table style="border-collapse:collapse');
    // header cells styled + shaded
    expect(html).toMatch(/<th style="[^"]*border:1px solid/);
    // body cells styled
    expect(html).toMatch(/<td style="[^"]*border:1px solid/);
    // wrapped for horizontal scroll on mobile
    expect(html).toContain('overflow-x:auto');
    // zebra-striped body rows (two distinct row backgrounds)
    expect(html).toContain('background:#ffffff;');
    expect(html).toContain('background:#f6f8fa;');
  });

  it('styles headings, paragraphs, and lists inline', () => {
    const { html } = renderEmail('## Title\n\nText here.\n\n- one\n- two');
    expect(html).toMatch(/<h2 style="[^"]*font-weight:600/);
    expect(html).toMatch(/<p style="[^"]*margin/);
    expect(html).toMatch(/<ul style="[^"]*padding-left/);
    expect(html).toMatch(/<li style=/);
  });

  it('renders links with inline style and safe target/rel', () => {
    const { html } = renderEmail('[site](https://example.com)');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toMatch(/<a [^>]*style="[^"]*color:/);
  });

  it('renders inline code and fenced code blocks with escaping', () => {
    const { html } = renderEmail('Use `x < y` here.\n\n```\nif (a < b) {}\n```');
    expect(html).toMatch(/<code style="[^"]*font-family/);
    expect(html).toContain('<pre style="');
    // angle brackets escaped, never emitted as raw tags
    expect(html).toContain('x &lt; y');
    expect(html).toContain('a &lt; b');
  });

  it('escapes raw HTML in the markdown (no injection)', () => {
    const { html } = renderEmail('hi <script>alert(1)</script> there');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders an horizontal rule', () => {
    const { html } = renderEmail('above\n\n---\n\nbelow');
    expect(html).toMatch(/<hr style="[^"]*border-top/);
  });
});

describe('htmlToPlainText', () => {
  it('extracts readable text from an HTML body (e.g. a forwarded HTML email)', () => {
    const html =
      '<html><body><p>My note before forwarding.</p><hr><h1>50% Off</h1>' +
      '<p>Hello <b>there</b>, see <a href="http://x.com">this</a>.</p></body></html>';
    const text = htmlToPlainText(html);
    expect(text).toContain('My note before forwarding.');
    expect(text).toContain('50% OFF');
    expect(text).toContain('Hello there');
    expect(text).toContain('http://x.com');
    expect(text).not.toContain('<');
  });

  it('renders a table as aligned text', () => {
    const text = htmlToPlainText('<table><tr><th>Name</th><th>Qty</th></tr><tr><td>Apples</td><td>3</td></tr></table>');
    expect(text.toLowerCase()).toContain('name');
    expect(text).toContain('Apples');
    expect(text).toContain('3');
  });

  it('drops images', () => {
    expect(htmlToPlainText('<p>before</p><img src="http://x/y.png" alt="logo"><p>after</p>')).not.toContain('logo');
  });
});
