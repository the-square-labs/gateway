import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from './cli.js';
import { CodexUsageComponentService, resolveUsageComponentPaths } from './codex-usage-components.js';
import { isInteractiveInvocation, signalExitCode } from './codex-usage-runtime.js';
import type { Output } from './output.js';
import { resolveCliPaths } from './paths.js';

async function fixture(platform: NodeJS.Platform) {
  const home = await mkdtemp(join(tmpdir(), 'gateway-codex-usage-'));
  const paths = resolveCliPaths({}, platform, home);
  await mkdir(paths.runtimeDir, { recursive: true });
  await writeFile(paths.runtimeFile, '#!/usr/bin/env node\n');
  const launchEnv = { value: '', getenvCode: 0, unsetCode: 0 };
  const commandRunner = vi.fn(async (command: string, args: string[]) => {
    if (args.includes('generate-json-schema')) {
      const out = args.at(-1)!;
      await mkdir(join(out, 'v2'), { recursive: true });
      await writeFile(join(out, 'v2', 'GetAccountRateLimitsResponse.json'), '{"rateLimitsByLimitId":{}}');
      await writeFile(join(out, 'v2', 'GetAccountTokenUsageResponse.json'), '{"dailyUsageBuckets":[]}');
      await writeFile(join(out, 'v2', 'AccountRateLimitsUpdatedNotification.json'), '{}');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (command === '/bin/launchctl' && args[0] === 'getenv') {
      return { code: launchEnv.getenvCode, stdout: launchEnv.value, stderr: 'getenv failed' };
    }
    if (command === '/bin/launchctl' && args[0] === 'setenv') launchEnv.value = args[2];
    if (command === '/bin/launchctl' && args[0] === 'unsetenv') {
      if (launchEnv.unsetCode === 0) launchEnv.value = '';
      return { code: launchEnv.unsetCode, stdout: '', stderr: 'unsetenv failed' };
    }
    return { code: 0, stdout: '', stderr: '' };
  });
  return { home, paths, commandRunner, launchEnv };
}

describe('Codex usage component lifecycle', () => {
  it('installs and independently removes owned macOS Desktop and CLI components', async () => {
    const files = await fixture('darwin');
    const service = new CodexUsageComponentService(files.paths, {
      platform: 'darwin',
      home: files.home,
      commandRunner: files.commandRunner,
    });
    await service.setup({
      profileName: 'default',
      remoteBaseUrl: 'https://gateway.example/api/inference/v1',
      realCodexPath: '/Applications/ChatGPT.app/Contents/Resources/codex',
      realCodexVersion: '0.149.0',
      desktopUsage: true,
      cliUsage: true,
    });
    const paths = resolveUsageComponentPaths(files.paths, {}, files.home);
    await expect(readFile(paths.desktopWrapperFile, 'utf8')).resolves.toContain('__desktop_wrapper');
    await expect(readFile(paths.gatewayCodexLauncherFile, 'utf8')).resolves.toContain('__gateway_codex');
    expect(files.launchEnv.value).toBe(paths.desktopWrapperFile);
    expect(await service.inspect()).toMatchObject({ desktop: true, cli: true });
    expect(
      await service.doctor({
        token: 'gwi_test',
        fetch: async () =>
          new Response(
            JSON.stringify({
              enabled: true,
              api: { configured: false, percentage: 0, recoveryAt: '2026-09-01T00:00:00.000Z' },
              subscription: {
                '5h': { configured: true, percentage: 10, recoveryAt: '2026-08-23T18:00:00.000Z' },
                '7d': { configured: true, percentage: 20, recoveryAt: '2026-08-30T00:00:00.000Z' },
                '30d': { configured: false, percentage: 0, recoveryAt: '2026-09-22T00:00:00.000Z' },
              },
              tokens: { lifetime: 100, daily: [] },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          ),
      })
    ).toMatchObject({ ok: true });

    const repaired = await service.setup({
      profileName: 'default',
      remoteBaseUrl: 'https://gateway.example/api/inference/v1',
      realCodexPath: paths.desktopWrapperFile,
      realCodexVersion: '0.149.0',
      desktopUsage: true,
      cliUsage: true,
    });
    expect(repaired.realCodexPath).toBe('/Applications/ChatGPT.app/Contents/Resources/codex');

    await service.uninstall('desktop');
    expect(files.launchEnv.value).toBe('');
    expect(await service.inspect()).toMatchObject({ desktop: false, cli: true });
    await service.uninstall('all');
    expect(await service.inspect()).toMatchObject({ desktop: false, cli: false });
  });

  it('creates a distinct Linux XDG launcher and preserves foreign artifacts', async () => {
    const files = await fixture('linux');
    const service = new CodexUsageComponentService(files.paths, {
      platform: 'linux',
      home: files.home,
      commandRunner: files.commandRunner,
    });
    const appImage = join(files.home, 'ChatGPT.AppImage');
    await writeFile(appImage, '#!/bin/sh\n');
    await chmod(appImage, 0o700);
    await service.setup({
      profileName: 'default',
      remoteBaseUrl: 'https://gateway.example/api/inference/v1',
      realCodexPath: '/usr/bin/codex',
      realCodexVersion: '0.149.0',
      desktopUsage: true,
      desktopCommand: appImage,
    });
    const paths = resolveUsageComponentPaths(files.paths, {}, files.home);
    await expect(readFile(paths.linuxDesktopEntryFile, 'utf8')).resolves.toContain('Name=ChatGPT (Gateway)');
    await mkdir(join(files.home, '.local', 'bin'), { recursive: true });
    await writeFile(paths.gatewayCodexLauncherFile, '#!/bin/sh\necho foreign\n');
    await expect(
      service.setup({
        profileName: 'default',
        remoteBaseUrl: 'https://gateway.example/api/inference/v1',
        realCodexPath: '/usr/bin/codex',
        realCodexVersion: '0.149.0',
        cliUsage: true,
      })
    ).rejects.toMatchObject({ code: 'CODEX_USAGE_ARTIFACT_CONFLICT' });
    await expect(readFile(paths.gatewayCodexLauncherFile, 'utf8')).resolves.toContain('foreign');
  });

  it('rejects Windows wrappers and confined Linux Desktop installs before mutation', async () => {
    const windows = await fixture('win32');
    const windowsService = new CodexUsageComponentService(windows.paths, {
      platform: 'win32',
      home: windows.home,
      commandRunner: windows.commandRunner,
    });
    await expect(
      windowsService.setup({
        profileName: 'default',
        remoteBaseUrl: 'https://gateway.example/api/inference/v1',
        realCodexPath: 'codex.exe',
        realCodexVersion: '0.149.0',
        cliUsage: true,
      })
    ).rejects.toMatchObject({ code: 'CODEX_USAGE_UNSUPPORTED_PLATFORM' });

    const linux = await fixture('linux');
    const linuxService = new CodexUsageComponentService(linux.paths, {
      platform: 'linux',
      home: linux.home,
      commandRunner: linux.commandRunner,
    });
    const linuxPaths = resolveUsageComponentPaths(linux.paths, {}, linux.home);
    await expect(
      linuxService.setup({
        profileName: 'default',
        remoteBaseUrl: 'https://gateway.example/api/inference/v1',
        realCodexPath: '/usr/bin/codex',
        realCodexVersion: '0.149.0',
        desktopUsage: true,
        desktopCommand: '/usr/bin/flatpak run com.openai.ChatGPT',
      })
    ).rejects.toMatchObject({ code: 'CODEX_DESKTOP_UNSUPPORTED_INSTALL' });
    await expect(access(linuxPaths.desktopWrapperFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a foreign macOS CODEX_CLI_PATH before replacing owned artifacts', async () => {
    const files = await fixture('darwin');
    files.launchEnv.value = '/usr/local/bin/foreign-codex';
    const service = new CodexUsageComponentService(files.paths, {
      platform: 'darwin',
      home: files.home,
      commandRunner: files.commandRunner,
      env: { CODEX_CLI_PATH: '/usr/local/bin/foreign-codex' },
    });
    const paths = resolveUsageComponentPaths(files.paths, {}, files.home);
    await expect(
      service.setup({
        profileName: 'default',
        remoteBaseUrl: 'https://gateway.example/api/inference/v1',
        realCodexPath: '/Applications/ChatGPT.app/Contents/Resources/codex',
        realCodexVersion: '0.149.0',
        desktopUsage: true,
      })
    ).rejects.toMatchObject({ code: 'CODEX_CLI_PATH_CONFLICT' });
    await expect(access(paths.desktopWrapperFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps macOS artifacts and state when launchctl removal fails', async () => {
    const files = await fixture('darwin');
    const service = new CodexUsageComponentService(files.paths, {
      platform: 'darwin',
      home: files.home,
      commandRunner: files.commandRunner,
    });
    await service.setup({
      profileName: 'default',
      remoteBaseUrl: 'https://gateway.example/api/inference/v1',
      realCodexPath: '/Applications/ChatGPT.app/Contents/Resources/codex',
      realCodexVersion: '0.149.0',
      desktopUsage: true,
    });
    const paths = resolveUsageComponentPaths(files.paths, {}, files.home);
    files.launchEnv.unsetCode = 1;
    await expect(service.uninstall('desktop')).rejects.toMatchObject({ code: 'CODEX_DESKTOP_REMOVAL_FAILED' });
    await expect(access(paths.desktopWrapperFile)).resolves.toBeUndefined();
    await expect(access(paths.macLaunchAgentFile)).resolves.toBeUndefined();
    await expect(access(paths.stateFile)).resolves.toBeUndefined();

    files.launchEnv.unsetCode = 0;
    files.launchEnv.getenvCode = 1;
    await expect(service.uninstall('desktop')).rejects.toMatchObject({ code: 'CODEX_DESKTOP_REMOVAL_FAILED' });
    await expect(access(paths.desktopWrapperFile)).resolves.toBeUndefined();
  });

  it('uses valid component state to clear a stale macOS environment after artifacts disappear', async () => {
    const files = await fixture('darwin');
    const service = new CodexUsageComponentService(files.paths, {
      platform: 'darwin',
      home: files.home,
      commandRunner: files.commandRunner,
    });
    await service.setup({
      profileName: 'default',
      remoteBaseUrl: 'https://gateway.example/api/inference/v1',
      realCodexPath: '/Applications/ChatGPT.app/Contents/Resources/codex',
      realCodexVersion: '0.149.0',
      desktopUsage: true,
    });
    const paths = resolveUsageComponentPaths(files.paths, {}, files.home);
    await rm(paths.desktopWrapperFile, { force: true });
    await rm(paths.macLaunchAgentFile, { force: true });

    await service.uninstall('desktop');

    expect(files.launchEnv.value).toBe('');
    await expect(access(paths.stateFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stores independent macOS Desktop and standalone CLI Codex bindings', async () => {
    const files = await fixture('darwin');
    const service = new CodexUsageComponentService(files.paths, {
      platform: 'darwin',
      home: files.home,
      commandRunner: files.commandRunner,
    });
    const state = await service.setup({
      profileName: 'default',
      remoteBaseUrl: 'https://gateway.example/api/inference/v1',
      realCodexPath: '/usr/local/bin/codex',
      realCodexVersion: '0.149.0',
      desktopCommand: '/Applications/ChatGPT.app',
      desktopUsage: true,
      cliUsage: true,
    });
    expect(state.desktop?.realCodexPath).toBe('/Applications/ChatGPT.app/Contents/Resources/codex');
    expect(state.cli?.realCodexPath).toBe('/usr/local/bin/codex');
  });

  it('discovers a compatible Linux AppImage from an XDG desktop entry', async () => {
    const files = await fixture('linux');
    const applications = join(files.home, '.local', 'share', 'applications');
    const appImage = join(files.home, 'ChatGPT.AppImage');
    await mkdir(applications, { recursive: true });
    await writeFile(appImage, '#!/bin/sh\n');
    await chmod(appImage, 0o700);
    await writeFile(
      join(applications, 'chatgpt.desktop'),
      `[Desktop Entry]\nName=ChatGPT Community\nExec="${appImage}" --ozone-platform=wayland %U\n`
    );
    const service = new CodexUsageComponentService(files.paths, {
      platform: 'linux',
      home: files.home,
      commandRunner: files.commandRunner,
    });
    const state = await service.setup({
      profileName: 'default',
      remoteBaseUrl: 'https://gateway.example/api/inference/v1',
      realCodexPath: '/usr/bin/codex',
      realCodexVersion: '0.149.0',
      desktopUsage: true,
    });
    expect(state.desktop).toMatchObject({ appCommand: appImage, appArgs: ['--ozone-platform=wayland'] });
    const paths = resolveUsageComponentPaths(files.paths, {}, files.home);
    await expect(readFile(paths.linuxDesktopEntryFile, 'utf8')).resolves.toContain('--ozone-platform=wayland');
    const repaired = await service.setup({
      profileName: 'default',
      remoteBaseUrl: 'https://gateway.example/api/inference/v1',
      realCodexPath: '/usr/bin/codex',
      realCodexVersion: '0.149.0',
      desktopUsage: true,
    });
    expect(repaired.desktop).toMatchObject({ appCommand: appImage, appArgs: ['--ozone-platform=wayland'] });
  });

  it('removes owned Linux artifacts even when the component state file is missing', async () => {
    const files = await fixture('linux');
    const paths = resolveUsageComponentPaths(files.paths, {}, files.home);
    await mkdir(join(files.home, '.local', 'share', 'applications'), { recursive: true });
    await writeFile(paths.desktopWrapperFile, '#!/bin/sh\n# wiolett-gateway-codex-usage-v1\n');
    await writeFile(paths.linuxDesktopEntryFile, '[Desktop Entry]\n# wiolett-gateway-codex-usage-v1\n');
    const service = new CodexUsageComponentService(files.paths, { platform: 'linux', home: files.home });
    await service.uninstall('desktop');
    await service.uninstall('desktop');
    await expect(access(paths.desktopWrapperFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(paths.linuxDesktopEntryFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes owned artifacts when the component state file is corrupt', async () => {
    const files = await fixture('linux');
    const paths = resolveUsageComponentPaths(files.paths, {}, files.home);
    await mkdir(join(files.home, '.local', 'bin'), { recursive: true });
    await writeFile(paths.gatewayCodexLauncherFile, '#!/bin/sh\n# wiolett-gateway-codex-usage-v1\n');
    await writeFile(paths.stateFile, '{not-json');
    const service = new CodexUsageComponentService(files.paths, { platform: 'linux', home: files.home });
    await service.uninstall('cli');
    await expect(access(paths.gatewayCodexLauncherFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(paths.stateFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats valid-JSON malformed component state as unknown during offline removal', async () => {
    const files = await fixture('linux');
    const paths = resolveUsageComponentPaths(files.paths, {}, files.home);
    await mkdir(join(files.home, '.local', 'share', 'applications'), { recursive: true });
    await writeFile(paths.desktopWrapperFile, '#!/bin/sh\n# wiolett-gateway-codex-usage-v1\n');
    await writeFile(paths.linuxDesktopEntryFile, '[Desktop Entry]\n# wiolett-gateway-codex-usage-v1\n');
    await writeFile(paths.stateFile, JSON.stringify({ version: 1, desktop: { platform: 'other' } }));
    const service = new CodexUsageComponentService(files.paths, { platform: 'linux', home: files.home });
    await service.uninstall('desktop');
    await expect(access(paths.linuxDesktopEntryFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exposes an offline targetless public uninstall command', async () => {
    const files = await fixture('linux');
    const paths = resolveUsageComponentPaths(files.paths, {}, files.home);
    await mkdir(join(files.home, '.local', 'bin'), { recursive: true });
    await writeFile(paths.gatewayCodexLauncherFile, '#!/bin/sh\n# wiolett-gateway-codex-usage-v1\n');
    await writeFile(
      paths.stateFile,
      JSON.stringify({
        version: 1,
        profileName: 'default',
        remoteBaseUrl: 'https://gateway.example/api/inference/v1',
        realCodexPath: '/usr/bin/codex',
        realCodexVersion: '0.149.0',
        schemaHash: 'hash',
        cli: {
          realCodexPath: '/usr/bin/codex',
          realCodexVersion: '0.149.0',
          schemaHash: 'hash',
          artifacts: [paths.gatewayCodexLauncherFile],
        },
      })
    );
    const rendered: string[] = [];
    const output: Output = { json: false, write: (_value, render) => rendered.push(render()) };
    expect(
      await runCli(['uninstall', 'codex-usage'], {
        paths: files.paths,
        home: files.home,
        interactive: false,
        output,
      })
    ).toBe(0);
    await expect(access(paths.gatewayCodexLauncherFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(rendered.at(-1)).toContain('all');
  });

  it('rejects usage setup flags on unrelated commands', async () => {
    const files = await fixture('linux');
    const rendered: string[] = [];
    const output: Output = { json: false, write: (_value, render) => rendered.push(render()) };
    expect(
      await runCli(['login', 'https://gateway.example', '--cli-usage'], {
        paths: files.paths,
        home: files.home,
        interactive: false,
        output,
      })
    ).toBe(1);
    expect(rendered.at(-1)).toContain('supported only by setup codex');
  });
});

describe('gateway-codex command routing', () => {
  it('wraps TUI sessions and forwards non-interactive subcommands', () => {
    expect(isInteractiveInvocation([])).toBe(true);
    expect(isInteractiveInvocation(['resume', '--last'])).toBe(true);
    expect(isInteractiveInvocation(['--profile', 'work', 'resume', '--last'])).toBe(true);
    expect(isInteractiveInvocation(['exec', 'say hello'])).toBe(false);
    expect(isInteractiveInvocation(['--profile', 'work', 'exec', 'say hello'])).toBe(false);
    expect(isInteractiveInvocation(['--model', 'gpt-5', 'review', '--uncommitted'])).toBe(false);
    expect(isInteractiveInvocation(['help', 'exec'])).toBe(false);
    expect(isInteractiveInvocation(['e', 'say hello'])).toBe(false);
    expect(isInteractiveInvocation(['a', 'patch.diff'])).toBe(false);
    expect(isInteractiveInvocation(['--remote', 'ws://127.0.0.1:9999'])).toBe(false);
    expect(isInteractiveInvocation(['--remote=ws://127.0.0.1:9999'])).toBe(false);
    expect(isInteractiveInvocation(['--remote-auth-token-env', 'TOKEN'])).toBe(false);
    expect(isInteractiveInvocation(['--remote-auth-token-env=TOKEN'])).toBe(false);
    expect(isInteractiveInvocation(['--version'])).toBe(false);
  });

  it('preserves conventional signal exit codes', () => {
    expect(signalExitCode('SIGINT')).toBe(130);
    expect(signalExitCode('SIGTERM')).toBe(143);
  });
});
