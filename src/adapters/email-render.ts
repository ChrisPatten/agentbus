/**
 * Markdown → rich-text email rendering for the email adapter (E21).
 *
 * The agent writes Markdown; we render it to a self-contained HTML document with
 * **inline** styles (most email clients strip `<head>`/`<style>`, so every visual
 * style must live on the element itself) plus a small `<style>` block for the few
 * things that can only be expressed as media queries (dark mode, mobile sizing).
 *
 * The original Markdown is returned as the plain-text alternative — Markdown is
 * already readable as text, so a client that prefers `text/plain` gets a clean
 * fallback for free (the email is sent `multipart/alternative`).
 *
 * Safety: markdown-it runs with `html: false`, so any raw HTML in the agent's text
 * is escaped, not rendered — no injection surface.
 */
import MarkdownIt from 'markdown-it';

/** Rendered output: a full HTML document and a plain-text fallback. */
export interface RenderedEmail {
  html: string;
  text: string;
}

type RenderRule = NonNullable<MarkdownIt['renderer']['rules'][string]>;

// System font stacks — render natively on macOS/iOS, Windows, Android, and web.
const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif," +
  "'Apple Color Emoji','Segoe UI Emoji'";
const MONO_STACK =
  "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";

// Inline styles per element. GitHub-ish light palette; dark mode is handled by the
// media query in the document head (which overrides these with !important).
const S = {
  h1: 'margin:0 0 16px;font-size:24px;line-height:1.3;font-weight:600;',
  h2: 'margin:24px 0 12px;font-size:20px;line-height:1.3;font-weight:600;',
  h3: 'margin:20px 0 8px;font-size:17px;line-height:1.3;font-weight:600;',
  h4: 'margin:16px 0 8px;font-size:15px;line-height:1.3;font-weight:600;',
  p: 'margin:0 0 16px;',
  ul: 'margin:0 0 16px;padding-left:24px;',
  ol: 'margin:0 0 16px;padding-left:24px;',
  li: 'margin:0 0 4px;',
  blockquote:
    'margin:0 0 16px;padding:8px 16px;border-left:4px solid #d0d7de;color:#57606a;background:#f6f8fa;',
  table: 'border-collapse:collapse;width:100%;font-size:14px;',
  th: 'border:1px solid #d0d7de;padding:8px 12px;text-align:left;background:#f6f8fa;font-weight:600;',
  td: 'border:1px solid #d0d7de;padding:8px 12px;text-align:left;',
  trEven: 'background:#ffffff;',
  trOdd: 'background:#f6f8fa;',
  a: 'color:#0969da;text-decoration:underline;',
  hr: 'border:0;border-top:1px solid #d0d7de;margin:24px 0;',
  codeInline: `font-family:${MONO_STACK};font-size:13px;background:#f6f8fa;padding:2px 6px;border-radius:4px;`,
  pre: `font-family:${MONO_STACK};font-size:13px;background:#f6f8fa;padding:12px 16px;border-radius:6px;overflow-x:auto;margin:0 0 16px;`,
  codeInPre: `font-family:${MONO_STACK};background:transparent;padding:0;`,
  img: 'max-width:100%;height:auto;',
} as const;

const HEADING_STYLE: Record<string, string> = {
  h1: S.h1,
  h2: S.h2,
  h3: S.h3,
  h4: S.h4,
  h5: S.h4,
  h6: S.h4,
};

/** A render rule that just stamps a fixed inline style onto the open token. */
function withStyle(style: string): RenderRule {
  return (tokens, idx, options, _env, self) => {
    tokens[idx]!.attrSet('style', style);
    return self.renderToken(tokens, idx, options);
  };
}

function buildRenderer(): MarkdownIt {
  // breaks: true — a single newline becomes <br>, matching how an assistant tends
  // to write (chat-style) rather than strict Markdown's "newline = space".
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });

  md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
    tokens[idx]!.attrSet('style', HEADING_STYLE[tokens[idx]!.tag] ?? S.h4);
    return self.renderToken(tokens, idx, options);
  };

  md.renderer.rules.paragraph_open = withStyle(S.p);
  md.renderer.rules.bullet_list_open = withStyle(S.ul);
  md.renderer.rules.ordered_list_open = withStyle(S.ol);
  md.renderer.rules.list_item_open = withStyle(S.li);
  md.renderer.rules.blockquote_open = withStyle(S.blockquote);
  md.renderer.rules.th_open = withStyle(S.th);
  md.renderer.rules.td_open = withStyle(S.td);

  md.renderer.rules.hr = (tokens, idx, options, _env, self) => {
    tokens[idx]!.attrSet('style', S.hr);
    return self.renderToken(tokens, idx, options);
  };

  // Links: style + open safely in a new context.
  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const t = tokens[idx]!;
    t.attrSet('style', S.a);
    t.attrSet('target', '_blank');
    t.attrSet('rel', 'noopener noreferrer');
    return self.renderToken(tokens, idx, options);
  };

  md.renderer.rules.image = (tokens, idx, options, _env, self) => {
    tokens[idx]!.attrSet('style', S.img);
    return self.renderToken(tokens, idx, options);
  };

  // Tables: wrap in a horizontally-scrollable box so wide tables don't blow out
  // narrow mobile viewports, and zebra-stripe the body rows for readability.
  md.renderer.rules.table_open = (tokens, idx, options, _env, self) => {
    tokens[idx]!.attrSet('style', S.table);
    return '<div style="overflow-x:auto;margin:0 0 16px;">' + self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.table_close = (tokens, idx, options, _env, self) => {
    return self.renderToken(tokens, idx, options) + '</div>';
  };
  md.renderer.rules.tbody_open = (tokens, idx, options, env, self) => {
    (env as { inTbody?: boolean; rowIdx?: number }).inTbody = true;
    (env as { rowIdx?: number }).rowIdx = 0;
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.tbody_close = (tokens, idx, options, env, self) => {
    (env as { inTbody?: boolean }).inTbody = false;
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.tr_open = (tokens, idx, options, env, self) => {
    const e = env as { inTbody?: boolean; rowIdx?: number };
    if (e.inTbody) {
      const even = (e.rowIdx ?? 0) % 2 === 0;
      e.rowIdx = (e.rowIdx ?? 0) + 1;
      tokens[idx]!.attrSet('style', even ? S.trEven : S.trOdd);
    }
    return self.renderToken(tokens, idx, options);
  };

  // Code: full overrides so we control the inline styling (and still escape).
  md.renderer.rules.code_inline = (tokens, idx) =>
    `<code style="${S.codeInline}">${md.utils.escapeHtml(tokens[idx]!.content)}</code>`;
  const renderPre: RenderRule = (tokens, idx) =>
    `<pre style="${S.pre}"><code style="${S.codeInPre}">${md.utils.escapeHtml(tokens[idx]!.content)}</code></pre>`;
  md.renderer.rules.fence = renderPre;
  md.renderer.rules.code_block = renderPre;

  return md;
}

// The renderer is stateless across calls (per-render state rides `env`), so build
// it once for the process.
let renderer: MarkdownIt | null = null;
function getRenderer(): MarkdownIt {
  if (!renderer) renderer = buildRenderer();
  return renderer;
}

/** Wrap rendered body HTML in a responsive, dark-mode-aware email document. */
function wrapDocument(inner: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  @media (prefers-color-scheme: dark) {
    body, .email-bg { background:#1a1a1a !important; }
    .email-card { background:#1f2023 !important; color:#e6e6e6 !important; }
    .email-card a { color:#539bf5 !important; }
    .email-card blockquote { background:#26282c !important; color:#aab1b9 !important; border-left-color:#3a3f44 !important; }
    .email-card th { background:#26282c !important; }
    .email-card th, .email-card td { border-color:#3a3f44 !important; }
    .email-card code, .email-card pre { background:#26282c !important; }
    .email-card tr[style*="#ffffff"] { background:#1f2023 !important; }
    .email-card tr[style*="#f6f8fa"] { background:#26282c !important; }
  }
  @media (max-width:600px) {
    .email-card { padding:16px !important; }
  }
</style>
</head>
<body class="email-bg" style="margin:0;padding:0;background:#f4f4f7;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <div class="email-card" style="max-width:680px;margin:0 auto;padding:24px;font-family:${FONT_STACK};font-size:16px;line-height:1.6;color:#1a1a1a;word-wrap:break-word;overflow-wrap:break-word;">
${inner}
  </div>
</body>
</html>`;
}

/**
 * Render the agent's Markdown body into a rich-text HTML document and a plain-text
 * fallback (the original Markdown). Returns both parts for a `multipart/alternative`
 * send.
 */
export function renderEmail(markdown: string): RenderedEmail {
  const inner = getRenderer().render(markdown, {});
  return { html: wrapDocument(inner), text: markdown };
}
