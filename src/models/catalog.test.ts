import { describe, it, expect } from 'vitest';
import type { AppConfig } from '../config/schema.js';
import { AppConfigSchema } from '../config/schema.js';
import {
  BUILTIN_MODELS,
  compareVersions,
  familyLabel,
  loadCatalog,
  resolveModelQuery,
  type ModelEntry,
} from './catalog.js';

/** Built-ins plus an older Opus 5.0, so `opus 5` has two candidates. */
const CATALOG: ModelEntry[] = [
  ...BUILTIN_MODELS,
  { id: 'claude-opus-5-0', family: 'opus', version: '5.0', label: 'Opus 5.0' },
];

function cfg(models?: AppConfig['models']): AppConfig {
  return { models } as unknown as AppConfig;
}

describe('resolveModelQuery — successful resolution', () => {
  const cases: Array<[string, string, boolean]> = [
    // [input, expected id, exact]
    ['claude-opus-5-5', 'claude-opus-5-5', true],
    ['  CLAUDE-OPUS-5-5 ', 'claude-opus-5-5', true],
    ['claude-sonnet-4-6', 'claude-sonnet-4-6', true], // deprecated, exact id
    ['haiku', 'claude-haiku-5-5', false],
    ['opus', 'claude-opus-5-5', false],
    ['sonnet', 'claude-sonnet-5-5', false], // older sonnets are deprecated
    ['fable', 'claude-fable-5-1', false],
    ['haiku 4.5', 'claude-haiku-4-5', false],
    ['haiku-4.5', 'claude-haiku-4-5', false],
    ['haiku_4.5', 'claude-haiku-4-5', false],
    ['haiku4.5', 'claude-haiku-4-5', false],
    ['claude haiku 4.5', 'claude-haiku-4-5', false],
    ['claude-haiku-4.5', 'claude-haiku-4-5', false],
    ['HAIKU 4.5', 'claude-haiku-4-5', false],
    ['haiku 4', 'claude-haiku-4-5', false],
    ['opus 5', 'claude-opus-5-5', false], // highest 5.x
    ['opus 5.5', 'claude-opus-5-5', false],
    ['opus 5.0', 'claude-opus-5-0', false],
    ['sonnet 4.6', 'claude-sonnet-4-6', false], // deprecated reachable by version
    ['sonnet 4', 'claude-sonnet-4-6', false],
    ['sonnet 5', 'claude-sonnet-5-5', false],
  ];

  it.each(cases)('%j → %s (exact=%s)', (input, id, exact) => {
    const r = resolveModelQuery(input, CATALOG);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.id).toBe(id);
    expect(r.exact).toBe(exact);
  });

  it('family only falls back to a deprecated entry when the family has nothing else', () => {
    const cat: ModelEntry[] = [{ id: 'x-old', family: 'mono', version: '1', label: 'Mono 1', deprecated: true }];
    const r = resolveModelQuery('mono', cat);
    expect(r.ok && r.entry.id).toBe('x-old');
  });
});

describe('resolveModelQuery — claude- escape hatch', () => {
  it.each(['claude-opus-6', 'claude-haiku-5-20270101', 'Claude-Newthing-1'])(
    '%j is accepted as a synthetic exact entry',
    (input) => {
      const r = resolveModelQuery(input, CATALOG);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const id = input.trim().toLowerCase();
      expect(r.exact).toBe(true);
      expect(r.entry).toEqual({ id, family: 'unknown', version: '', label: id });
    },
  );

  it('does not treat non-id-shaped claude input as an escape hatch', () => {
    const r = resolveModelQuery('claude-haiku-5.1', CATALOG);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unknown-version');
  });
});

describe('resolveModelQuery — failures', () => {
  it('empty input', () => {
    for (const input of ['', '   ']) {
      const r = resolveModelQuery(input, CATALOG);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toBe('empty');
      expect(r.suggestions.map((e) => e.id)).toEqual([
        'claude-fable-5-1',
        'claude-opus-5-5',
        'claude-sonnet-5-5',
        'claude-haiku-5-5',
      ]);
    }
  });

  it.each(['gpt', 'gemini 2', 'claude', 'opus!'])('unknown family %j', (input) => {
    const r = resolveModelQuery(input, CATALOG);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unknown-family');
    expect(r.message).toContain('Fable, Opus, Sonnet, Haiku');
    // latest non-deprecated entry of each family
    expect(r.suggestions.map((e) => e.id)).toEqual([
      'claude-fable-5-1',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
    ]);
  });

  it('known family, unknown version', () => {
    const r = resolveModelQuery('haiku 5.1', CATALOG);
    expect(r).toEqual({
      ok: false,
      reason: 'unknown-version',
      message: 'No Haiku 5.1 — known: 5.5',
      suggestions: [BUILTIN_MODELS.find((e) => e.family === 'haiku')],
    });
  });

  it('unknown version lists live entries latest first, excluding deprecated', () => {
    const r = resolveModelQuery('opus 4', CATALOG);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toBe('No Opus 4 — known: 5.5, 5.0');
    expect(r.suggestions.map((e) => e.id)).toEqual(['claude-opus-5-5', 'claude-opus-5-0']);

    const s = resolveModelQuery('sonnet 3', CATALOG);
    expect(!s.ok && s.message).toBe('No Sonnet 3 — known: 5.5');
  });

  it('opus 5.5.1 does not match opus 5.5', () => {
    const r = resolveModelQuery('opus 5.5.1', CATALOG);
    expect(!r.ok && r.reason).toBe('unknown-version');
  });
});

describe('loadCatalog', () => {
  it('returns the built-ins when config has no models section', () => {
    expect(loadCatalog(cfg())).toEqual(BUILTIN_MODELS);
    expect(loadCatalog(cfg({}))).toEqual(BUILTIN_MODELS);
  });

  it('appends new config entries and overrides built-ins by id', () => {
    const catalog = loadCatalog(
      cfg({
        catalog: [
          { id: 'claude-opus-5-6', family: 'Opus', version: '5.6', label: 'Opus 5.6' },
          { id: 'claude-sonnet-4-6', family: 'sonnet', version: '4.6', label: 'Sonnet 4.6 (legacy)' },
        ],
      }),
    );
    expect(catalog).toHaveLength(BUILTIN_MODELS.length + 1);
    const sonnet46 = catalog.find((e) => e.id === 'claude-sonnet-4-6')!;
    expect(sonnet46.label).toBe('Sonnet 4.6 (legacy)');
    expect(sonnet46.deprecated).toBeUndefined();
    expect(catalog.at(-1)).toMatchObject({ id: 'claude-opus-5-6', family: 'opus' });

    const r = resolveModelQuery('opus', catalog);
    expect(r.ok && r.entry.id).toBe('claude-opus-5-6');
  });

  it('does not mutate BUILTIN_MODELS', () => {
    const before = JSON.stringify(BUILTIN_MODELS);
    loadCatalog(cfg({ catalog: [{ id: 'claude-opus-5-5', family: 'opus', version: '5.5', label: 'X' }] }));
    expect(JSON.stringify(BUILTIN_MODELS)).toBe(before);
  });
});

describe('models config schema', () => {
  const base = {
    bus: { http_port: 3000, db_path: ':memory:', log_level: 'info' },
    adapters: {},
    memory: {},
  };

  it('accepts a models.catalog section and lower-cases family', () => {
    const parsed = AppConfigSchema.safeParse({
      ...base,
      models: { catalog: [{ id: 'claude-opus-5-6', family: 'Opus', version: '5.6', label: 'Opus 5.6' }] },
    });
    if (!parsed.success) throw parsed.error;
    expect(parsed.data.models?.catalog?.[0]?.family).toBe('opus');
  });

  it('rejects a non-dotted version', () => {
    const parsed = AppConfigSchema.safeParse({
      ...base,
      models: { catalog: [{ id: 'x', family: 'opus', version: 'five', label: 'X' }] },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('helpers', () => {
  it.each([
    ['5.5', '5.0', 1],
    ['5', '5.0', 0],
    ['4.10', '4.9', 1],
    ['4.5', '5', -1],
  ] as const)('compareVersions(%s, %s) sign %i', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });

  it('familyLabel capitalises', () => {
    expect(familyLabel('haiku')).toBe('Haiku');
  });
});
