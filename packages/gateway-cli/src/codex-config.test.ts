import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureCodex,
  inspectCodexConfiguration,
  removeCodexConfiguration,
  resolveCodexPaths,
} from './codex-config.js';
import type { CliPaths } from './paths.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gateway-codex-config-'));
  const paths: CliPaths = {
    configDir: join(root, 'gateway-config'),
    dataDir: join(root, 'gateway-data'),
    profilesFile: join(root, 'gateway-config', 'profiles.json'),
    fileCredentialsFile: join(root, 'gateway-data', 'credentials.json'),
    runtimeDir: join(root, 'gateway-data', 'runtime'),
    runtimeFile: join(root, 'gateway-data', 'runtime', 'gateway-cli.js'),
  };
  const codex = resolveCodexPaths(paths, 'work', { CODEX_HOME: join(root, 'codex') }, root);
  return { root, paths, codex };
}

describe('Codex managed configuration', () => {
  it('preserves unrelated TOML and restores prior root selections on removal', async () => {
    const { paths, codex } = await fixture();
    const original = `# user comment
model = "custom"
model_provider = "old-provider"
model_catalog_json = "/old/catalog.json"

[features]
fast_mode = true
`;
    await mkdir(codex.codexHome, { recursive: true });
    await writeFile(codex.configFile, original);

    const first = await configureCodex({
      paths: codex,
      profile: 'work',
      baseUrl: 'https://gateway.example.com/api/inference/codex/v1',
      runtimeFile: paths.runtimeFile,
    });
    const configured = await readFile(codex.configFile, 'utf8');
    expect(configured).toContain('# user comment');
    expect(configured).toContain('model = "custom"');
    expect(configured).toContain('[features]');
    expect(configured).toContain(`model_provider = "${first.providerId}"`);
    expect(configured).toContain(`[model_providers."${first.providerId}".auth]`);
    expect(configured).toContain(`[mcp_servers."${first.mcpId}"]`);
    expect(configured).not.toContain('gwi_');

    const second = await configureCodex({
      paths: codex,
      profile: 'work',
      baseUrl: 'https://gateway.example.com/api/inference/codex/v1',
      runtimeFile: paths.runtimeFile,
    });
    expect(second.changed).toBe(false);
    expect((await readFile(codex.configFile, 'utf8')).match(/wiolett-gateway:provider:work/g)).toHaveLength(2);

    expect(first.backupFile).not.toBe(second.backupFile);
    const removed = await removeCodexConfiguration({ paths: codex, profile: 'work' });
    expect(removed).toMatchObject({ removed: true, conflicts: [] });
    const restored = await readFile(codex.configFile, 'utf8');
    expect(restored).toContain('model_provider = "old-provider"');
    expect(restored).toContain('model_catalog_json = "/old/catalog.json"');
    expect(restored).not.toContain('wiolett-gateway:');
  });

  it('switches among named profiles and falls back to the prior profile on removal', async () => {
    const { root, paths, codex } = await fixture();
    await mkdir(codex.codexHome, { recursive: true });
    await writeFile(codex.configFile, '[features]\nfast_mode = true\n');
    const work = await configureCodex({
      paths: codex,
      profile: 'work',
      baseUrl: 'https://work.example/api/inference/codex/v1',
      runtimeFile: paths.runtimeFile,
      now: () => new Date('2026-07-28T00:00:00Z'),
    });
    const personal = resolveCodexPaths(paths, 'personal', { CODEX_HOME: join(root, 'codex') }, root);
    const personalResult = await configureCodex({
      paths: personal,
      profile: 'personal',
      baseUrl: 'https://personal.example/api/inference/codex/v1',
      runtimeFile: paths.runtimeFile,
      now: () => new Date('2026-07-28T01:00:00Z'),
    });
    expect(await readFile(codex.configFile, 'utf8')).toContain(`model_provider = "${personalResult.providerId}"`);

    await removeCodexConfiguration({ paths: personal, profile: 'personal' });
    expect(await readFile(codex.configFile, 'utf8')).toContain(`model_provider = "${work.providerId}"`);
    expect((await inspectCodexConfiguration({ paths: codex, profile: 'work' })).active).toBe(true);
  });

  it('removes package-owned blocks even when their contents were edited', async () => {
    const { paths, codex } = await fixture();
    await mkdir(codex.codexHome, { recursive: true });
    await configureCodex({
      paths: codex,
      profile: 'work',
      baseUrl: 'https://gateway.example/api/inference/codex/v1',
      runtimeFile: paths.runtimeFile,
    });
    const changed = (await readFile(codex.configFile, 'utf8')).replace('name = "OpenAI"', 'name = "User edited"');
    await writeFile(codex.configFile, changed);

    const result = await removeCodexConfiguration({ paths: codex, profile: 'work' });
    expect(result).toMatchObject({ removed: true, conflicts: [] });
    expect(await readFile(codex.configFile, 'utf8')).not.toContain('name = "User edited"');
  });

  it('ignores formatting, extra fields, and tunable values while checking required integration fields', async () => {
    const { paths, codex } = await fixture();
    await mkdir(codex.codexHome, { recursive: true });
    await configureCodex({
      paths: codex,
      profile: 'work',
      baseUrl: 'https://gateway.example/api/inference/codex/v1',
      runtimeFile: paths.runtimeFile,
    });
    const configured = await readFile(codex.configFile, 'utf8');
    const harmlesslyEdited = configured
      .replace('wire_api = "responses"', 'wire_api    =    "responses"')
      .replace('timeout_ms = 5000', 'timeout_ms = 9000\ncustom_setting = true');
    await writeFile(codex.configFile, harmlesslyEdited);

    expect(await inspectCodexConfiguration({ paths: codex, profile: 'work' })).toMatchObject({
      configured: true,
      conflicts: [],
    });

    await writeFile(
      codex.configFile,
      harmlesslyEdited.replace(
        'base_url = "https://gateway.example/api/inference/codex/v1"',
        'base_url = "https://other.example/api/inference/codex/v1"'
      )
    );
    expect(await inspectCodexConfiguration({ paths: codex, profile: 'work' })).toMatchObject({
      configured: true,
      conflicts: ['model provider'],
    });
  });

  it('uses collision-resistant identifiers for distinct permitted profile names', async () => {
    const { root, paths, codex } = await fixture();
    const dotted = resolveCodexPaths(paths, 'a.b', { CODEX_HOME: join(root, 'codex') }, root);
    const dashed = resolveCodexPaths(paths, 'a-b', { CODEX_HOME: join(root, 'codex') }, root);
    expect(dotted.profileDir).not.toBe(dashed.profileDir);

    const first = await configureCodex({
      paths: dotted,
      profile: 'a.b',
      baseUrl: 'https://dotted.example/api/inference/codex/v1',
      runtimeFile: paths.runtimeFile,
    });
    const second = await configureCodex({
      paths: dashed,
      profile: 'a-b',
      baseUrl: 'https://dashed.example/api/inference/codex/v1',
      runtimeFile: paths.runtimeFile,
    });

    expect(first.providerId).not.toBe(second.providerId);
    expect(first.mcpId).not.toBe(second.mcpId);
    const config = await readFile(codex.configFile, 'utf8');
    expect(config).toContain(first.providerId);
    expect(config).toContain(second.providerId);
  });

  it('journals configuration before replacement and recovers an interrupted write', async () => {
    const { root, paths, codex } = await fixture();
    await mkdir(codex.codexHome, { recursive: true });
    await writeFile(codex.configFile, 'model_provider = "original"\n');
    await configureCodex({
      paths: codex,
      profile: 'work',
      baseUrl: 'https://work.example/api/inference/codex/v1',
      runtimeFile: paths.runtimeFile,
    });
    const stableConfig = await readFile(codex.configFile, 'utf8');
    const stableState = await readFile(codex.stateFile, 'utf8');
    const personal = resolveCodexPaths(paths, 'personal', { CODEX_HOME: join(root, 'codex') }, root);
    let interruptedConfig = '';
    let pendingState = '';

    await expect(
      configureCodex({
        paths: personal,
        profile: 'personal',
        baseUrl: 'https://personal.example/api/inference/codex/v1',
        runtimeFile: paths.runtimeFile,
        afterConfigWrite: async () => {
          interruptedConfig = await readFile(codex.configFile, 'utf8');
          pendingState = await readFile(codex.stateFile, 'utf8');
          expect(JSON.parse(pendingState).pending).toBeTruthy();
          throw new Error('simulated interruption');
        },
      })
    ).rejects.toThrow('simulated interruption');
    expect(await readFile(codex.configFile, 'utf8')).toBe(stableConfig);
    expect(await readFile(codex.stateFile, 'utf8')).toBe(stableState);

    await writeFile(codex.configFile, interruptedConfig);
    await writeFile(codex.stateFile, pendingState);
    expect((await inspectCodexConfiguration({ paths: codex, profile: 'work' })).configured).toBe(true);
    expect(await readFile(codex.configFile, 'utf8')).toBe(stableConfig);
    expect(await readFile(codex.stateFile, 'utf8')).toBe(stableState);
    expect((await inspectCodexConfiguration({ paths: personal, profile: 'personal' })).configured).toBe(false);
  });
});
