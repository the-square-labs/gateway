import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CommandRunner } from './codex-integration.js';
import { CliError } from './errors.js';
import type { CliPaths } from './paths.js';

const MARKER = 'wiolett-gateway-codex-usage-v1';

export async function removeLegacyCodexUsageComponents(
  paths: CliPaths,
  input: {
    target?: 'desktop' | 'cli' | 'all';
    platform?: NodeJS.Platform;
    commandRunner?: CommandRunner;
    env?: NodeJS.ProcessEnv;
    home?: string;
  } = {}
): Promise<{ desktop: boolean; cli: boolean; removed: string[] }> {
  const target = input.target ?? 'all';
  const platform = input.platform ?? process.platform;
  const home = input.home ?? homedir();
  const env = input.env ?? process.env;
  const owned = legacyPaths(paths, env, home);
  const removed: string[] = [];

  if (target === 'desktop' || target === 'all') {
    if (platform === 'darwin') {
      const launchAgentOwned = await isOwned(owned.macLaunchAgentFile);
      const wrapperOwned = await isOwned(owned.desktopWrapperFile);
      const stateExists = await exists(owned.stateFile);
      if (launchAgentOwned || wrapperOwned || stateExists) {
        const current = await run(input.commandRunner, '/bin/launchctl', ['getenv', 'CODEX_CLI_PATH'], env);
        if (current.code !== 0) {
          throw new CliError(
            'CODEX_USAGE_CLEANUP_FAILED',
            current.stderr || 'Could not inspect the legacy CODEX_CLI_PATH activation.'
          );
        }
        if (current.stdout.trim() === owned.desktopWrapperFile) {
          const unset = await run(input.commandRunner, '/bin/launchctl', ['unsetenv', 'CODEX_CLI_PATH'], env);
          if (unset.code !== 0) {
            throw new CliError(
              'CODEX_USAGE_CLEANUP_FAILED',
              unset.stderr || 'Could not remove the legacy CODEX_CLI_PATH activation.'
            );
          }
        }
      }
    }
    await removeOwned(owned.desktopWrapperFile, removed);
    await removeOwned(owned.desktopLauncherFile, removed);
    await removeOwned(owned.linuxDesktopEntryFile, removed);
    await removeOwned(owned.macLaunchAgentFile, removed);
    const macExecutableOwned = await isOwned(owned.macDesktopExecutableFile);
    const macInfoOwned = await isOwned(owned.macDesktopInfoFile);
    if (macExecutableOwned || macInfoOwned) {
      await Promise.all([
        removeOwned(owned.macDesktopExecutableFile, removed),
        removeOwned(owned.macDesktopInfoFile, removed),
      ]);
      await rm(owned.macDesktopAppDir, { recursive: true, force: true });
      removed.push(owned.macDesktopAppDir);
    }
    if (platform === 'linux' && removed.includes(owned.linuxDesktopEntryFile)) {
      const lookup = await run(
        input.commandRunner,
        '/usr/bin/env',
        ['sh', '-lc', 'command -v update-desktop-database'],
        env
      );
      const command = lookup.code === 0 ? lookup.stdout.trim() : '';
      if (command) await run(input.commandRunner, command, [dirname(owned.linuxDesktopEntryFile)], env);
    }
  }

  if (target === 'cli' || target === 'all') {
    await removeOwned(owned.gatewayCodexLauncherFile, removed);
  }

  await rm(owned.stateFile, { force: true });
  return {
    desktop: target === 'desktop' || target === 'all',
    cli: target === 'cli' || target === 'all',
    removed,
  };
}

function legacyPaths(paths: CliPaths, env: NodeJS.ProcessEnv, home: string) {
  const macDesktopAppDir = join(home, 'Applications', 'ChatGPT (Gateway).app');
  return {
    stateFile: join(paths.dataDir, 'codex-usage.json'),
    desktopWrapperFile: join(paths.runtimeDir, 'codex-desktop-wrapper'),
    desktopLauncherFile: join(paths.runtimeDir, 'chatgpt-gateway-launcher'),
    gatewayCodexLauncherFile: join(home, '.local', 'bin', 'gateway-codex'),
    linuxDesktopEntryFile: join(
      env.XDG_DATA_HOME || join(home, '.local', 'share'),
      'applications',
      'chatgpt-gateway.desktop'
    ),
    macLaunchAgentFile: join(home, 'Library', 'LaunchAgents', 'net.wiolett.gateway.codex-usage.plist'),
    macDesktopAppDir,
    macDesktopInfoFile: join(macDesktopAppDir, 'Contents', 'Info.plist'),
    macDesktopExecutableFile: join(macDesktopAppDir, 'Contents', 'MacOS', 'chatgpt-gateway'),
  };
}

async function isOwned(path: string): Promise<boolean> {
  try {
    return (await readFile(path, 'utf8')).includes(MARKER);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function removeOwned(path: string, removed: string[]): Promise<void> {
  if (!(await isOwned(path))) return;
  await rm(path, { force: true });
  removed.push(path);
}

async function run(commandRunner: CommandRunner | undefined, command: string, args: string[], env: NodeJS.ProcessEnv) {
  if (commandRunner) return commandRunner(command, args, env);
  const { spawn } = await import('node:child_process');
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => resolve({ code: 1, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
