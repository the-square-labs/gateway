import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeCodeApiKeyHelper,
  configureClaudeCode,
  inspectClaudeCodeConfiguration,
  removeClaudeCodeConfiguration,
  resolveClaudeCodePaths,
} from './claude-code-config.js';
import type { CliPaths } from './paths.js';

describe('Claude Code configuration', () => {
  it('merges owned settings and restores only package-managed values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gateway-claude-config-'));
    const paths = cliPaths(root);
    const resolved = resolveClaudeCodePaths(paths, 'default', {}, root);
    await mkdir(resolved.configDir, { recursive: true });
    await writeFile(
      resolved.configFile,
      JSON.stringify({ theme: 'dark', env: { KEEP_ME: 'yes' }, permissions: { allow: ['Read'] } }, null, 2)
    );

    await configureClaudeCode({
      paths: resolved,
      profile: 'default',
      baseUrl: 'https://gateway.example.com/api/inference/anthropic/',
      model: 'claude-gateway-model',
      runtimeFile: paths.runtimeFile,
    });
    const configured = JSON.parse(await readFile(resolved.configFile, 'utf8'));
    expect(configured).toMatchObject({
      theme: 'dark',
      permissions: { allow: ['Read'] },
      apiKeyHelper: claudeCodeApiKeyHelper(paths.runtimeFile),
      env: {
        KEEP_ME: 'yes',
        ANTHROPIC_BASE_URL: 'https://gateway.example.com/api/inference/anthropic',
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-gateway-model',
      },
    });
    expect(await inspectClaudeCodeConfiguration({ paths: resolved })).toMatchObject({
      configured: true,
      conflicts: [],
      model: 'claude-gateway-model',
    });

    configured.env.ADDED_LATER = 'preserved';
    await writeFile(resolved.configFile, JSON.stringify(configured, null, 2));
    expect(await removeClaudeCodeConfiguration({ paths: resolved })).toEqual({ removed: true, conflicts: [] });
    expect(JSON.parse(await readFile(resolved.configFile, 'utf8'))).toEqual({
      theme: 'dark',
      env: { KEEP_ME: 'yes', ADDED_LATER: 'preserved' },
      permissions: { allow: ['Read'] },
    });
  });

  it('refuses to overwrite or remove foreign edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gateway-claude-config-'));
    const paths = cliPaths(root);
    const resolved = resolveClaudeCodePaths(paths, 'default', {}, root);
    await mkdir(resolved.configDir, { recursive: true });
    await writeFile(resolved.configFile, JSON.stringify({ apiKeyHelper: 'foreign-helper' }));
    await expect(
      configureClaudeCode({
        paths: resolved,
        profile: 'default',
        baseUrl: 'https://gateway.example.com/api/inference/anthropic',
        model: 'claude-gateway-model',
        runtimeFile: paths.runtimeFile,
      })
    ).rejects.toMatchObject({ code: 'CLAUDE_CONFIG_CONFLICT' });

    await writeFile(resolved.configFile, '{}');
    await configureClaudeCode({
      paths: resolved,
      profile: 'default',
      baseUrl: 'https://gateway.example.com/api/inference/anthropic',
      model: 'claude-gateway-model',
      runtimeFile: paths.runtimeFile,
    });
    const configured = JSON.parse(await readFile(resolved.configFile, 'utf8'));
    configured.env.ANTHROPIC_BASE_URL = 'https://edited.example.com';
    await writeFile(resolved.configFile, JSON.stringify(configured));
    await expect(removeClaudeCodeConfiguration({ paths: resolved })).resolves.toMatchObject({
      removed: false,
      conflicts: ['env.ANTHROPIC_BASE_URL'],
    });
  });
});

function cliPaths(root: string): CliPaths {
  return {
    configDir: root,
    dataDir: root,
    profilesFile: join(root, 'profiles.json'),
    fileCredentialsFile: join(root, 'credentials.json'),
    runtimeDir: join(root, 'runtime'),
    runtimeFile: join(root, 'runtime', 'gateway-cli.js'),
  };
}
