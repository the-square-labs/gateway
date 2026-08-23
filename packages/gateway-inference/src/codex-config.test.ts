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
  it('keeps an explicit companion home in the installed MCP command', async () => {
    const { paths, codex } = await fixture();
    await configureCodex({
      paths: codex,
      profile: 'work',
      model: 'gateway-model',
      baseUrl: 'https://gateway.example.com/api/inference/v1',
      proxyBaseUrl: 'http://127.0.0.1:55555/v1',
      runtimeFile: paths.runtimeFile,
      cliHome: '/data/inference',
    });
    const configured = await readFile(codex.configFile, 'utf8');
    expect(configured).toContain(`args = ["${paths.runtimeFile}", "--home", "/data/inference", "__mcp"]`);
  });

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
      model: 'gateway-model',
      baseUrl: 'https://gateway.example.com/api/inference/v1',
      proxyBaseUrl: 'http://127.0.0.1:55555/v1',
      runtimeFile: paths.runtimeFile,
    });
    const configured = await readFile(codex.configFile, 'utf8');
    expect(configured).toContain('# user comment');
    expect(configured).toContain('model = "gateway-model"');
    expect(configured).toContain('authenticates through a local proxy');
    expect(configured).toContain('[features]');
    expect(configured).toContain(`model_provider = "${first.providerId}"`);
    expect(first.providerId).toBe('openai');
    expect(configured).toContain(`[mcp_servers."${first.mcpId}"]`);
    expect(configured).not.toContain('gwi_');
    expect(configured).toContain('openai_base_url = "http://127.0.0.1:55555/v1"');
    expect(configured).not.toContain('cli_auth_credentials_store');

    const second = await configureCodex({
      paths: codex,
      profile: 'work',
      model: 'gateway-model',
      baseUrl: 'https://gateway.example.com/api/inference/v1',
      proxyBaseUrl: 'http://127.0.0.1:55555/v1',
      runtimeFile: paths.runtimeFile,
    });
    expect(second.changed).toBe(false);
    expect((await readFile(codex.configFile, 'utf8')).match(/# Gateway Inference keeps Codex/g)).toHaveLength(1);

    expect(first.backupFile).not.toBe(second.backupFile);
    const removed = await removeCodexConfiguration({ paths: codex, profile: 'work' });
    expect(removed).toMatchObject({ removed: true, conflicts: [] });
    const restored = await readFile(codex.configFile, 'utf8');
    expect(restored).toContain('model = "custom"');
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
      model: 'work-model',
      baseUrl: 'https://work.example/api/inference/v1',
      proxyBaseUrl: 'http://127.0.0.1:51001/v1',
      runtimeFile: paths.runtimeFile,
      now: () => new Date('2026-07-28T00:00:00Z'),
    });
    const personal = resolveCodexPaths(paths, 'personal', { CODEX_HOME: join(root, 'codex') }, root);
    const personalResult = await configureCodex({
      paths: personal,
      profile: 'personal',
      model: 'personal-model',
      baseUrl: 'https://personal.example/api/inference/v1',
      proxyBaseUrl: 'http://127.0.0.1:51002/v1',
      runtimeFile: paths.runtimeFile,
      now: () => new Date('2026-07-28T01:00:00Z'),
    });
    expect(await readFile(codex.configFile, 'utf8')).toContain(`model_provider = "${personalResult.providerId}"`);

    await removeCodexConfiguration({ paths: personal, profile: 'personal' });
    expect(await readFile(codex.configFile, 'utf8')).toContain(`model_provider = "${work.providerId}"`);
    expect(await readFile(codex.configFile, 'utf8')).toContain('model = "work-model"');
    expect((await inspectCodexConfiguration({ paths: codex, profile: 'work' })).active).toBe(true);
  });

  it('removes package-owned blocks even when their contents were edited', async () => {
    const { paths, codex } = await fixture();
    await mkdir(codex.codexHome, { recursive: true });
    await configureCodex({
      paths: codex,
      profile: 'work',
      model: 'gateway-model',
      baseUrl: 'https://gateway.example/api/inference/v1',
      proxyBaseUrl: 'http://127.0.0.1:55555/v1',
      runtimeFile: paths.runtimeFile,
    });
    const changed = (await readFile(codex.configFile, 'utf8')).replace(
      'openai_base_url = "http://127.0.0.1:55555/v1"',
      'openai_base_url = "https://user-edited.example/v1"'
    );
    await writeFile(codex.configFile, changed);

    const result = await removeCodexConfiguration({ paths: codex, profile: 'work' });
    expect(result).toMatchObject({ removed: true, conflicts: [] });
    expect(await readFile(codex.configFile, 'utf8')).not.toContain('user-edited.example');
  });

  it('repairs an incomplete marker left by a Codex config rewrite', async () => {
    const { paths, codex } = await fixture();
    await mkdir(codex.codexHome, { recursive: true });
    const input = {
      paths: codex,
      profile: 'work',
      model: 'gateway-model',
      baseUrl: 'https://gateway.example/api/inference/v1',
      proxyBaseUrl: 'http://127.0.0.1:55555/v1',
      runtimeFile: paths.runtimeFile,
    };
    await configureCodex(input);
    await writeFile(codex.configFile, `# >>> wiolett-gateway:active\n${await readFile(codex.configFile, 'utf8')}`);

    await expect(configureCodex(input)).resolves.toMatchObject({ providerId: 'openai' });
    const repaired = await readFile(codex.configFile, 'utf8');
    expect(repaired).not.toContain('>>> wiolett-gateway');
    expect(repaired.match(/# Gateway Inference keeps Codex/g)).toHaveLength(1);
    expect(await inspectCodexConfiguration({ paths: codex, profile: 'work' })).toMatchObject({
      configured: true,
      conflicts: [],
    });
  });

  it('isolates managed configuration state between Codex homes', async () => {
    const { root, paths, codex } = await fixture();
    await mkdir(codex.codexHome, { recursive: true });
    await writeFile(codex.configFile, '[features]\nold_home = true\n');
    await configureCodex({
      paths: codex,
      profile: 'work',
      model: 'gateway-model',
      baseUrl: 'https://gateway.example/api/inference/v1',
      proxyBaseUrl: 'http://127.0.0.1:55555/v1',
      runtimeFile: paths.runtimeFile,
    });

    const nextHome = resolveCodexPaths(paths, 'work', { CODEX_HOME: join(root, 'codex-next') }, root);
    await mkdir(nextHome.codexHome, { recursive: true });
    await writeFile(nextHome.configFile, '[features]\nnew_home = true\n');

    expect(nextHome.stateFile).not.toBe(codex.stateFile);
    expect(await inspectCodexConfiguration({ paths: nextHome, profile: 'work' })).toMatchObject({
      configured: false,
      conflicts: [],
    });
    expect(await readFile(nextHome.configFile, 'utf8')).toBe('[features]\nnew_home = true\n');
    await expect(readFile(nextHome.stateFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(
      configureCodex({
        paths: nextHome,
        profile: 'work',
        model: 'gateway-model',
        baseUrl: 'https://gateway.example/api/inference/v1',
        proxyBaseUrl: 'http://127.0.0.1:55555/v1',
        runtimeFile: paths.runtimeFile,
      })
    ).resolves.toMatchObject({ configFile: nextHome.configFile });
    expect(await inspectCodexConfiguration({ paths: codex, profile: 'work' })).toMatchObject({
      configured: true,
      configFile: codex.configFile,
    });
    expect(await inspectCodexConfiguration({ paths: nextHome, profile: 'work' })).toMatchObject({
      configured: true,
      configFile: nextHome.configFile,
    });
    expect(await readFile(codex.configFile, 'utf8')).toContain('old_home = true');
    expect(await readFile(nextHome.configFile, 'utf8')).toContain('model_provider = "openai"');

    await expect(removeCodexConfiguration({ paths: nextHome, profile: 'work' })).resolves.toMatchObject({
      removed: true,
      conflicts: [],
    });
    expect(await readFile(nextHome.configFile, 'utf8')).toBe('[features]\nnew_home = true\n');
    expect(await readFile(codex.configFile, 'utf8')).toContain('model_provider = "openai"');
    expect(await inspectCodexConfiguration({ paths: codex, profile: 'work' })).toMatchObject({ configured: true });

    await expect(removeCodexConfiguration({ paths: codex, profile: 'work' })).resolves.toMatchObject({
      removed: true,
      conflicts: [],
    });
    expect(await readFile(codex.configFile, 'utf8')).toBe('[features]\nold_home = true\n');
  });

  it('ignores formatting, extra fields, and tunable values while checking required integration fields', async () => {
    const { paths, codex } = await fixture();
    await mkdir(codex.codexHome, { recursive: true });
    await configureCodex({
      paths: codex,
      profile: 'work',
      model: 'gateway-model',
      baseUrl: 'https://gateway.example/api/inference/v1',
      proxyBaseUrl: 'http://127.0.0.1:55555/v1',
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
        'openai_base_url = "http://127.0.0.1:55555/v1"',
        'openai_base_url = "https://other.example/api/inference/v1"'
      )
    );
    expect(await inspectCodexConfiguration({ paths: codex, profile: 'work' })).toMatchObject({
      configured: true,
      conflicts: ['active Codex selection'],
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
      model: 'dotted-model',
      baseUrl: 'https://dotted.example/api/inference/v1',
      proxyBaseUrl: 'http://127.0.0.1:51003/v1',
      runtimeFile: paths.runtimeFile,
    });
    const second = await configureCodex({
      paths: dashed,
      profile: 'a-b',
      model: 'dashed-model',
      baseUrl: 'https://dashed.example/api/inference/v1',
      proxyBaseUrl: 'http://127.0.0.1:51004/v1',
      runtimeFile: paths.runtimeFile,
    });

    expect(first.providerId).toBe('openai');
    expect(second.providerId).toBe('openai');
    expect(first.mcpId).not.toBe(second.mcpId);
    const config = await readFile(codex.configFile, 'utf8');
    expect(config).toContain(first.mcpId);
    expect(config).toContain(second.mcpId);
  });

  it('journals configuration before replacement and recovers an interrupted write', async () => {
    const { root, paths, codex } = await fixture();
    await mkdir(codex.codexHome, { recursive: true });
    await writeFile(codex.configFile, 'model_provider = "original"\n');
    await configureCodex({
      paths: codex,
      profile: 'work',
      model: 'work-model',
      baseUrl: 'https://work.example/api/inference/v1',
      proxyBaseUrl: 'http://127.0.0.1:51001/v1',
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
        model: 'personal-model',
        baseUrl: 'https://personal.example/api/inference/v1',
        proxyBaseUrl: 'http://127.0.0.1:51002/v1',
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

  it('journals removal and restores configuration after an interrupted write', async () => {
    const { paths, codex } = await fixture();
    await mkdir(codex.codexHome, { recursive: true });
    await writeFile(codex.configFile, 'model_provider = "original"\n');
    await configureCodex({
      paths: codex,
      profile: 'work',
      model: 'work-model',
      baseUrl: 'https://work.example/api/inference/v1',
      proxyBaseUrl: 'http://127.0.0.1:51001/v1',
      runtimeFile: paths.runtimeFile,
    });
    const stableConfig = await readFile(codex.configFile, 'utf8');
    const stableState = await readFile(codex.stateFile, 'utf8');

    await expect(
      removeCodexConfiguration({
        paths: codex,
        profile: 'work',
        afterConfigWrite: async () => {
          expect(JSON.parse(await readFile(codex.stateFile, 'utf8')).pending).toBeTruthy();
          throw new Error('simulated removal interruption');
        },
      })
    ).rejects.toThrow('simulated removal interruption');

    expect(await readFile(codex.configFile, 'utf8')).toBe(stableConfig);
    expect(await readFile(codex.stateFile, 'utf8')).toBe(stableState);
    expect(await inspectCodexConfiguration({ paths: codex, profile: 'work' })).toMatchObject({
      configured: true,
      conflicts: [],
    });
  });
});
