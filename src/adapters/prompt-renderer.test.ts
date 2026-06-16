import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSystemPrompt, expandFileReferences, type PromptContext } from './prompt-renderer.js';

const baseCtx: PromptContext = {
  contact_id: 'contact:alice',
  channel: 'telegram',
  date: '2026-06-16',
  memories: '## Memories\n- [pref] tea',
  session_summary: '## Last conversation\nTalked about hiking.',
  agent_id: 'agent:claude',
};

describe('renderSystemPrompt', () => {
  it('replaces known {{variables}}', () => {
    const out = renderSystemPrompt('Hi {{contact_id}} on {{channel}} ({{date}})', baseCtx);
    expect(out).toBe('Hi contact:alice on telegram (2026-06-16)');
  });

  it('leaves unknown placeholders verbatim', () => {
    const out = renderSystemPrompt('{{contact_id}} {{unknown}}', baseCtx);
    expect(out).toBe('contact:alice {{unknown}}');
  });

  it('interpolates the memories and session_summary blocks', () => {
    const out = renderSystemPrompt('{{memories}}\n\n{{session_summary}}', baseCtx);
    expect(out).toContain('## Memories');
    expect(out).toContain('## Last conversation');
  });
});

describe('expandFileReferences', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentbus-prompt-'));
    writeFileSync(join(dir, 'persona.md'), 'You are a calm assistant.', 'utf-8');
    writeFileSync(join(dir, 'facts.txt'), 'Sky is blue.', 'utf-8');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('inlines the contents of a referenced file', () => {
    const out = expandFileReferences('Persona: @persona.md', dir);
    expect(out).toBe('Persona: You are a calm assistant.');
  });

  it('expands multiple references and preserves leading whitespace', () => {
    const out = expandFileReferences('@persona.md\n@facts.txt', dir);
    expect(out).toBe('You are a calm assistant.\nSky is blue.');
  });

  it('leaves an unresolved reference untouched so the typo is visible', () => {
    const out = expandFileReferences('see @missing.md here', dir);
    expect(out).toBe('see @missing.md here');
  });

  it('does not treat an email-like token as a file reference', () => {
    // No leading whitespace/line-start before @, so it is not matched.
    const out = expandFileReferences('ping me at alice@persona.md ok', dir);
    expect(out).toBe('ping me at alice@persona.md ok');
  });
});
