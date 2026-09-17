import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePaneMcpConfig, cleanupPaneMcpConfig, type PaneMcpConfigOptions } from './mcp-config.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Real temp directories on disk (no fs mocking) — a fresh root per test, with
// `workingDir`/`outDir` as subdirectories, tracked here and removed in
// afterEach.

const fixtureRoots: string[] = [];

function setupFixture(): { workingDir: string; outDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'agentbus-pool-mcp-'));
  fixtureRoots.push(root);
  const workingDir = join(root, 'project');
  const outDir = join(root, 'out');
  mkdirSync(workingDir, { recursive: true });
  // outDir deliberately NOT pre-created — writePaneMcpConfig must create it.
  return { workingDir, outDir };
}

function baseOpts(overrides: Partial<PaneMcpConfigOptions> & { workingDir: string; outDir: string }): PaneMcpConfigOptions {
  return {
    paneAgentId: 'peggy-pool-2',
    agentbusConfigPath: '/abs/path/to/config.yaml',
    ...overrides,
  };
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── writePaneMcpConfig ───────────────────────────────────────────────────────

describe('writePaneMcpConfig', () => {
  it('generates an agentbus-only config when no project .mcp.json exists', () => {
    const { workingDir, outDir } = setupFixture();

    const outPath = writePaneMcpConfig(baseOpts({ workingDir, outDir }));
    const written = JSON.parse(readFileSync(outPath, 'utf-8'));

    expect(Object.keys(written.mcpServers)).toEqual(['agentbus']);
    expect(written.mcpServers.agentbus).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['tsx', expect.stringMatching(/src\/adapters\/cc\.js$/)],
      env: {
        AGENTBUS_CONFIG: '/abs/path/to/config.yaml',
        AGENTBUS_AGENT_ID: 'peggy-pool-2',
      },
    });
  });

  it('preserves an unrelated "bmp" server from the project .mcp.json and still sets agentbus correctly', () => {
    const { workingDir, outDir } = setupFixture();
    const projectConfig = {
      mcpServers: {
        bmp: { type: 'stdio', command: 'some-bmp-binary', args: ['--flag', 'value'] },
      },
    };
    writeFileSync(join(workingDir, '.mcp.json'), JSON.stringify(projectConfig), 'utf-8');

    const outPath = writePaneMcpConfig(
      baseOpts({ workingDir, outDir, paneAgentId: 'peggy-pool-3', agentbusConfigPath: '/abs/config-3.yaml' }),
    );
    const written = JSON.parse(readFileSync(outPath, 'utf-8'));

    expect(Object.keys(written.mcpServers).sort()).toEqual(['agentbus', 'bmp']);
    // bmp untouched, verbatim.
    expect(written.mcpServers.bmp).toEqual(projectConfig.mcpServers.bmp);
    // agentbus reflects this pane's own identity, not anything from the project file.
    expect(written.mcpServers.agentbus.env.AGENTBUS_AGENT_ID).toBe('peggy-pool-3');
    expect(written.mcpServers.agentbus.env.AGENTBUS_CONFIG).toBe('/abs/config-3.yaml');
  });

  it('overwrites a project .mcp.json that already hardcodes its own agentbus entry (the hazard this story exists to prevent)', () => {
    const { workingDir, outDir } = setupFixture();
    const projectConfig = {
      mcpServers: {
        agentbus: {
          type: 'stdio',
          command: 'npx',
          args: ['tsx', '/some/other/checked-in/path/cc.js'],
          env: {
            AGENTBUS_CONFIG: '/some/other/config.yaml',
            AGENTBUS_AGENT_ID: 'peggy', // hardcoded single agent id — the hazard
          },
        },
      },
    };
    writeFileSync(join(workingDir, '.mcp.json'), JSON.stringify(projectConfig), 'utf-8');

    const outPath = writePaneMcpConfig(
      baseOpts({ workingDir, outDir, paneAgentId: 'peggy-pool-4', agentbusConfigPath: '/abs/config-4.yaml' }),
    );
    const written = JSON.parse(readFileSync(outPath, 'utf-8'));

    expect(Object.keys(written.mcpServers)).toEqual(['agentbus']);
    expect(written.mcpServers.agentbus.env.AGENTBUS_AGENT_ID).toBe('peggy-pool-4');
    expect(written.mcpServers.agentbus.env.AGENTBUS_AGENT_ID).not.toBe('peggy');
    expect(written.mcpServers.agentbus.env.AGENTBUS_CONFIG).toBe('/abs/config-4.yaml');
    expect(written.mcpServers.agentbus.args).toEqual(['tsx', expect.stringMatching(/src\/adapters\/cc\.js$/)]);
  });

  it('does not throw and falls back to agentbus-only when the project .mcp.json contains invalid JSON', () => {
    const { workingDir, outDir } = setupFixture();
    writeFileSync(join(workingDir, '.mcp.json'), '{ this is not valid json,,,', 'utf-8');

    let outPath = '';
    expect(() => {
      outPath = writePaneMcpConfig(baseOpts({ workingDir, outDir, paneAgentId: 'peggy-pool-5' }));
    }).not.toThrow();

    const written = JSON.parse(readFileSync(outPath, 'utf-8'));
    expect(Object.keys(written.mcpServers)).toEqual(['agentbus']);
    expect(written.mcpServers.agentbus.env.AGENTBUS_AGENT_ID).toBe('peggy-pool-5');
  });

  it('produces two different file paths for two calls with the same workingDir/outDir', () => {
    const { workingDir, outDir } = setupFixture();
    const opts = baseOpts({ workingDir, outDir });

    const first = writePaneMcpConfig(opts);
    const second = writePaneMcpConfig(opts);

    expect(first).not.toBe(second);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
  });

  it('creates outDir recursively when it does not already exist', () => {
    const { workingDir, outDir } = setupFixture();
    expect(existsSync(outDir)).toBe(false);

    const outPath = writePaneMcpConfig(baseOpts({ workingDir, outDir: join(outDir, 'nested', 'deeper') }));

    expect(existsSync(outPath)).toBe(true);
  });
});

// ── cleanupPaneMcpConfig ─────────────────────────────────────────────────────

describe('cleanupPaneMcpConfig', () => {
  it('does not throw for a nonexistent path', () => {
    expect(() =>
      cleanupPaneMcpConfig('/tmp/agentbus-pool-mcp-definitely-does-not-exist-12345.json'),
    ).not.toThrow();
  });

  it('deletes a file that was actually written by writePaneMcpConfig', () => {
    const { workingDir, outDir } = setupFixture();
    const outPath = writePaneMcpConfig(baseOpts({ workingDir, outDir }));
    expect(existsSync(outPath)).toBe(true);

    cleanupPaneMcpConfig(outPath);

    expect(existsSync(outPath)).toBe(false);
  });
});
