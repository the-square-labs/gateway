import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandRunner } from './codex-integration.js';
import type { CliPaths } from './paths.js';
import { createInferenceStartupManager } from './startup.js';

async function fixture(): Promise<{ root: string; paths: CliPaths }> {
  const root = await mkdtemp(join(tmpdir(), 'gateway-inference-startup-'));
  const paths: CliPaths = {
    configDir: join(root, 'config'),
    dataDir: join(root, 'data'),
    homeDir: join(root, 'portable home'),
    profilesFile: join(root, 'config', 'profiles.json'),
    fileCredentialsFile: join(root, 'data', 'credentials.json'),
    runtimeDir: join(root, 'data', 'runtime'),
    runtimeFile: join(root, 'data', 'runtime', 'gateway-cli.js'),
  };
  await mkdir(paths.runtimeDir, { recursive: true });
  await writeFile(paths.runtimeFile, '#!/usr/bin/env node\n');
  return { root, paths };
}

describe('inference proxy startup', () => {
  it('installs and removes a macOS LaunchAgent using the private runtime', async () => {
    const { root, paths } = await fixture();
    const calls: Array<[string, string[]]> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, args]);
      return { code: 0, stdout: '', stderr: '' };
    };
    const manager = createInferenceStartupManager({
      platform: 'darwin',
      nodePath: '/Applications/Node Runtime/node',
      uid: 501,
      commandRunner: runner,
      isCodexConfigured: async () => true,
    });
    const input = { paths, profileName: 'default', home: root };

    const installed = await manager.install(input);
    expect(installed.installed).toBe(true);
    const plist = await readFile(installed.path!, 'utf8');
    expect(plist).toContain('/Applications/Node Runtime/node');
    expect(plist).toContain(paths.runtimeFile);
    expect(plist).toContain('<string>--home</string>');
    expect(calls).toContainEqual(['launchctl', ['bootstrap', 'gui/501', installed.path!]]);

    await manager.uninstall(input);
    expect(await manager.status(input)).toMatchObject({ installed: false, active: false });
  });

  it('installs a Linux systemd user service and enables it immediately', async () => {
    const { root, paths } = await fixture();
    const calls: Array<[string, string[]]> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, args]);
      return { code: 0, stdout: '', stderr: '' };
    };
    const manager = createInferenceStartupManager({
      platform: 'linux',
      nodePath: '/opt/node runtime/bin/node',
      commandRunner: runner,
      isCodexConfigured: async () => true,
    });
    const input = { paths, profileName: 'default', home: root, env: {} };

    const installed = await manager.install(input);
    const unit = await readFile(installed.path!, 'utf8');
    expect(unit).toContain(`ExecStart="/opt/node runtime/bin/node"`);
    expect(unit).toContain(`"${paths.runtimeFile}"`);
    expect(calls).toContainEqual(['systemctl', ['--user', 'enable', '--now', 'wiolett-gateway-inference.service']]);
  });
});
