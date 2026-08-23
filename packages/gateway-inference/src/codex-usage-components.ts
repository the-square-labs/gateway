import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type { CommandRunner } from './codex-integration.js';
import { GatewayUsageSource, gatewayUsageSchema, gatewayUsageUrl } from './codex-usage.js';
import { CliError } from './errors.js';
import { type Fetch, requestJson } from './http.js';
import type { CliPaths } from './paths.js';

const MARKER = 'wiolett-gateway-codex-usage-v1';

export interface CodexRuntimeBinding {
  realCodexPath: string;
  realCodexVersion: string;
  schemaHash: string;
}

interface DesktopCommand {
  executable: string;
  args: string[];
}

export interface CodexUsageState extends CodexRuntimeBinding {
  version: 1;
  profileName: string;
  remoteBaseUrl: string;
  desktop?: CodexRuntimeBinding & {
    platform: 'darwin' | 'linux';
    appCommand: string;
    appArgs: string[];
    artifacts: string[];
  };
  cli?: CodexRuntimeBinding & { artifacts: string[] };
}

const runtimeBindingSchema = z.object({
  realCodexPath: z.string().min(1),
  realCodexVersion: z.string(),
  schemaHash: z.string(),
});

const codexUsageStateSchema = runtimeBindingSchema
  .extend({
    version: z.literal(1),
    profileName: z.string().min(1),
    remoteBaseUrl: z.string(),
    desktop: runtimeBindingSchema
      .extend({
        platform: z.enum(['darwin', 'linux']),
        appCommand: z.string().min(1),
        appArgs: z.array(z.string()).default([]),
        artifacts: z.array(z.string()),
      })
      .optional(),
    cli: runtimeBindingSchema.extend({ artifacts: z.array(z.string()) }).optional(),
  })
  .strict();

export interface CodexUsageDoctorCheck {
  name: string;
  status: 'ok' | 'warning' | 'error';
  message: string;
}

export class CodexUsageComponentService {
  private readonly usagePaths: ReturnType<typeof resolveUsageComponentPaths>;

  constructor(
    private readonly paths: CliPaths,
    private readonly options: {
      platform?: NodeJS.Platform;
      commandRunner?: CommandRunner;
      env?: NodeJS.ProcessEnv;
      home?: string;
    } = {}
  ) {
    this.usagePaths = resolveUsageComponentPaths(paths, options.env, options.home);
  }

  async inspect(): Promise<{ state: CodexUsageState | null; desktop: boolean; cli: boolean }> {
    const state = await readState(this.usagePaths.stateFile);
    return { state, desktop: Boolean(state?.desktop), cli: Boolean(state?.cli) };
  }

  async doctor(
    input: { token?: string; fetch?: Fetch } = {}
  ): Promise<{ ok: boolean; checks: CodexUsageDoctorCheck[] }> {
    const state = await readState(this.usagePaths.stateFile);
    if (!state) {
      return {
        ok: true,
        checks: [{ name: 'Gateway usage wrappers', status: 'warning', message: 'Not configured' }],
      };
    }
    const checks: CodexUsageDoctorCheck[] = [];
    for (const [name, artifacts] of [
      ['Codex Desktop usage', state.desktop?.artifacts],
      ['gateway-codex', state.cli?.artifacts],
    ] as const) {
      if (!artifacts) continue;
      const ownership = await Promise.all(artifacts.map((artifact) => isOwned(artifact)));
      const invalid = ownership.findIndex((owned) => !owned);
      checks.push(
        invalid === -1
          ? { name, status: 'ok', message: 'Package-managed artifacts are intact' }
          : { name, status: 'error', message: `Missing or foreign artifact: ${artifacts[invalid]}` }
      );
    }
    for (const [name, binding] of [
      ['Codex Desktop usage protocol', state.desktop],
      ['gateway-codex protocol', state.cli],
    ] as const) {
      if (!binding) continue;
      try {
        const schemaHash = await this.protocolHash(binding.realCodexPath);
        checks.push(
          schemaHash === binding.schemaHash
            ? { name, status: 'ok', message: `Compatible with Codex ${binding.realCodexVersion}` }
            : { name, status: 'warning', message: 'Codex schema changed; rerun setup codex to revalidate it' }
        );
      } catch (error) {
        checks.push({
          name,
          status: 'error',
          message: error instanceof Error ? error.message : 'Protocol validation failed',
        });
      }
    }
    if (state.desktop || state.cli) {
      if (!input.token) {
        checks.push({ name: 'Gateway usage endpoint', status: 'error', message: 'Runtime token is missing' });
      } else {
        try {
          const current = await new GatewayUsageSource({
            usageUrl: gatewayUsageUrl(state.remoteBaseUrl),
            token: input.token,
            fetch: input.fetch,
          }).read();
          checks.push({
            name: 'Gateway usage endpoint',
            status: 'ok',
            message: current.enabled ? 'Authenticated usage is available' : 'Authenticated usage is disabled',
          });
        } catch (error) {
          checks.push({
            name: 'Gateway usage endpoint',
            status: 'error',
            message: error instanceof Error ? error.message : 'Gateway usage is unavailable',
          });
        }
      }
    }
    return { ok: checks.every((check) => check.status !== 'error'), checks };
  }

  async assertRuntimeCompatible(binding: CodexRuntimeBinding): Promise<void> {
    const schemaHash = await this.protocolHash(binding.realCodexPath);
    if (schemaHash !== binding.schemaHash) {
      throw new CliError(
        'CODEX_PROTOCOL_CHANGED',
        'The Codex app-server usage schema changed. Run setup codex again before using the wrapper.'
      );
    }
  }

  async assertGatewayUsageAvailable(input: { remoteBaseUrl: string; token: string; fetch?: Fetch }): Promise<void> {
    try {
      const payload = await requestJson<unknown>(
        gatewayUsageUrl(input.remoteBaseUrl),
        {},
        { fetch: input.fetch, accessToken: input.token, timeoutMs: 5_000 }
      );
      gatewayUsageSchema.parse(payload);
    } catch (error) {
      if (error instanceof CliError && (error.code === 'not_found' || error.code === 'HTTP_404')) {
        throw new CliError(
          'GATEWAY_USAGE_UNSUPPORTED',
          'This Gateway does not support Codex usage integration yet. Update Gateway before enabling Desktop or gateway-codex usage.',
          { cause: error }
        );
      }
      throw new CliError(
        'GATEWAY_USAGE_PREFLIGHT_FAILED',
        'Could not verify the Gateway usage endpoint. Optional Codex usage components were not activated.',
        { cause: error }
      );
    }
  }

  async preflight(input: { desktopUsage?: boolean; cliUsage?: boolean }): Promise<void> {
    const platform = this.options.platform ?? process.platform;
    const previous = await readState(this.usagePaths.stateFile);
    if ((input.desktopUsage || input.cliUsage) && platform !== 'darwin' && platform !== 'linux') {
      throw new CliError('CODEX_USAGE_UNSUPPORTED_PLATFORM', `Codex usage components are unsupported on ${platform}.`);
    }
    if (input.desktopUsage) {
      await assertOwnedOrMissing(this.usagePaths.desktopWrapperFile);
      if (platform === 'darwin') {
        await this.assertMacActivationAvailable();
        await this.discoverMacDesktop(undefined, '', undefined);
      } else if (platform === 'linux') {
        const command =
          previous?.desktop?.platform === 'linux'
            ? { executable: previous.desktop.appCommand, args: previous.desktop.appArgs }
            : await this.discoverLinuxDesktopCommand();
        if (isContainerizedDesktopCommand(command)) {
          throw new CliError(
            'CODEX_DESKTOP_UNSUPPORTED_INSTALL',
            'Flatpak and Snap ChatGPT/Codex Desktop installations are not supported by the usage wrapper.'
          );
        }
        await this.validateLinuxDesktopCommand(command);
        await assertOwnedOrMissing(this.usagePaths.linuxDesktopEntryFile);
      }
    }
    if (input.cliUsage) await assertOwnedOrMissing(this.usagePaths.gatewayCodexLauncherFile);
  }

  async setup(input: {
    profileName: string;
    remoteBaseUrl: string;
    realCodexPath: string;
    realCodexVersion: string;
    desktopUsage?: boolean;
    cliUsage?: boolean;
    desktopCommand?: string;
  }): Promise<CodexUsageState> {
    const platform = this.options.platform ?? process.platform;
    if ((input.desktopUsage || input.cliUsage) && platform !== 'darwin' && platform !== 'linux') {
      throw new CliError('CODEX_USAGE_UNSUPPORTED_PLATFORM', `Codex usage components are unsupported on ${platform}.`);
    }
    const previous = await readState(this.usagePaths.stateFile);
    const realCodexPath =
      input.realCodexPath === this.usagePaths.desktopWrapperFile && previous
        ? (previous.cli?.realCodexPath ?? previous.realCodexPath)
        : input.realCodexPath;
    const realCodexVersion =
      input.realCodexPath === this.usagePaths.desktopWrapperFile && previous
        ? (previous.cli?.realCodexVersion ?? previous.realCodexVersion)
        : input.realCodexVersion;
    const cliBinding: CodexRuntimeBinding = {
      realCodexPath,
      realCodexVersion,
      schemaHash: await this.protocolHash(realCodexPath),
    };
    let desktopCommand: DesktopCommand | undefined;
    let desktopBinding = cliBinding;
    if (input.desktopUsage) {
      await assertOwnedOrMissing(this.usagePaths.desktopWrapperFile);
      if (platform === 'darwin') {
        await this.assertMacActivationAvailable();
        const mac = await this.discoverMacDesktop(input.desktopCommand, input.realCodexPath, previous?.desktop);
        desktopCommand = { executable: mac.appPath, args: [] };
        desktopBinding = {
          realCodexPath: mac.codexPath,
          realCodexVersion: await this.codexVersion(mac.codexPath, input.realCodexVersion),
          schemaHash: await this.protocolHash(mac.codexPath),
        };
      } else {
        desktopCommand = input.desktopCommand
          ? parseDesktopCommand(input.desktopCommand)
          : previous?.desktop?.platform === 'linux'
            ? { executable: previous.desktop.appCommand, args: previous.desktop.appArgs }
            : await this.discoverLinuxDesktopCommand();
        if (isContainerizedDesktopCommand(desktopCommand)) {
          throw new CliError(
            'CODEX_DESKTOP_UNSUPPORTED_INSTALL',
            'Flatpak and Snap ChatGPT/Codex Desktop installations are not supported by the usage wrapper.'
          );
        }
        await this.validateLinuxDesktopCommand(desktopCommand);
        await assertOwnedOrMissing(this.usagePaths.linuxDesktopEntryFile);
      }
    }
    if (input.cliUsage) await assertOwnedOrMissing(this.usagePaths.gatewayCodexLauncherFile);
    const state: CodexUsageState = previous ?? {
      version: 1,
      profileName: input.profileName,
      remoteBaseUrl: input.remoteBaseUrl,
      ...cliBinding,
    };
    Object.assign(state, {
      profileName: input.profileName,
      remoteBaseUrl: input.remoteBaseUrl,
      ...cliBinding,
    });
    if (input.desktopUsage) {
      await this.installLauncher(this.usagePaths.desktopWrapperFile, '__desktop_wrapper');
      if (platform === 'darwin') {
        await this.installMacActivation();
        state.desktop = {
          ...desktopBinding,
          platform: 'darwin',
          appCommand: desktopCommand!.executable,
          appArgs: desktopCommand!.args,
          artifacts: [this.usagePaths.desktopWrapperFile, this.usagePaths.macLaunchAgentFile],
        };
      } else {
        await this.installLinuxActivation(desktopCommand!);
        state.desktop = {
          ...desktopBinding,
          platform: 'linux',
          appCommand: desktopCommand!.executable,
          appArgs: desktopCommand!.args,
          artifacts: [this.usagePaths.desktopWrapperFile, this.usagePaths.linuxDesktopEntryFile],
        };
      }
    }
    if (input.cliUsage) {
      await this.installLauncher(this.usagePaths.gatewayCodexLauncherFile, '__gateway_codex');
      state.cli = { ...cliBinding, artifacts: [this.usagePaths.gatewayCodexLauncherFile] };
    }
    await writeState(this.usagePaths.stateFile, state);
    return state;
  }

  async uninstall(target: 'desktop' | 'cli' | 'all' = 'all'): Promise<{ desktop: boolean; cli: boolean }> {
    const state = await readStateForUninstall(this.usagePaths.stateFile);
    const platform = this.options.platform ?? process.platform;
    let desktop = false;
    let cli = false;
    if (target === 'desktop' || target === 'all') {
      if (platform === 'darwin') await this.removeMacActivation(state?.desktop?.platform === 'darwin');
      if (platform === 'linux') {
        await removeOwned(this.usagePaths.linuxDesktopEntryFile);
        await this.refreshLinuxDesktopDatabase();
      }
      await removeOwned(this.usagePaths.desktopWrapperFile);
      if (state?.desktop) delete state.desktop;
      desktop = true;
    }
    if (target === 'cli' || target === 'all') {
      await removeOwned(this.usagePaths.gatewayCodexLauncherFile);
      if (state?.cli) delete state.cli;
      cli = true;
    }
    if (state?.desktop || state?.cli) await writeState(this.usagePaths.stateFile, state);
    else await rm(this.usagePaths.stateFile, { force: true });
    return { desktop, cli };
  }

  private async installLauncher(path: string, entrypoint: string): Promise<void> {
    await assertOwnedOrMissing(path);
    await atomicWrite(
      path,
      `#!/bin/sh\n# ${MARKER}\nexec ${shellQuote(process.execPath)} ${shellQuote(this.paths.runtimeFile)} ${entrypoint} "$@"\n`,
      0o700
    );
  }

  private async installMacActivation(): Promise<void> {
    await this.assertMacActivationAvailable();
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${MARKER} -->\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>net.wiolett.gateway.codex-usage</string><key>ProgramArguments</key><array><string>/bin/launchctl</string><string>setenv</string><string>CODEX_CLI_PATH</string><string>${xml(this.usagePaths.desktopWrapperFile)}</string></array><key>RunAtLoad</key><true/></dict></plist>\n`;
    await atomicWrite(this.usagePaths.macLaunchAgentFile, plist, 0o600);
    const result = await this.run('/bin/launchctl', ['setenv', 'CODEX_CLI_PATH', this.usagePaths.desktopWrapperFile]);
    if (result.code !== 0) throw new CliError('CODEX_DESKTOP_ACTIVATION_FAILED', result.stderr || 'launchctl failed');
  }

  private async assertMacActivationAvailable(): Promise<void> {
    const inherited = this.options.env?.CODEX_CLI_PATH ?? process.env.CODEX_CLI_PATH ?? '';
    if (inherited && inherited !== this.usagePaths.desktopWrapperFile) {
      throw new CliError('CODEX_CLI_PATH_CONFLICT', `CODEX_CLI_PATH is already set to ${inherited}.`);
    }
    const current = await this.run('/bin/launchctl', ['getenv', 'CODEX_CLI_PATH']);
    if (current.code !== 0) {
      throw new CliError('CODEX_DESKTOP_ACTIVATION_FAILED', current.stderr || 'Could not read CODEX_CLI_PATH.');
    }
    const configured = current.stdout.trim();
    if (configured && configured !== this.usagePaths.desktopWrapperFile) {
      throw new CliError('CODEX_CLI_PATH_CONFLICT', `CODEX_CLI_PATH is already set to ${configured}.`);
    }
    await assertOwnedOrMissing(this.usagePaths.macLaunchAgentFile);
  }

  private async discoverMacDesktop(
    requestedApp: string | undefined,
    requestedCodexPath: string,
    previous: CodexUsageState['desktop'] | undefined
  ): Promise<{ appPath: string; codexPath: string }> {
    const requestedFromCodex = macAppFromCodexPath(requestedCodexPath);
    if (requestedApp) {
      const appPath = requestedApp.replace(/\/$/, '');
      if (!appPath.endsWith('.app')) {
        throw new CliError('CODEX_DESKTOP_NOT_FOUND', `Expected a macOS .app bundle, received ${requestedApp}.`);
      }
      return { appPath, codexPath: join(appPath, 'Contents', 'Resources', 'codex') };
    }
    if (requestedFromCodex) return { appPath: requestedFromCodex, codexPath: requestedCodexPath };
    if (requestedCodexPath === this.usagePaths.desktopWrapperFile && previous) {
      return { appPath: previous.appCommand, codexPath: previous.realCodexPath };
    }
    const home = this.options.home ?? homedir();
    const candidates = [
      '/Applications/ChatGPT.app',
      join(home, 'Applications', 'ChatGPT.app'),
      '/Applications/Codex.app',
      join(home, 'Applications', 'Codex.app'),
    ];
    const found: Array<{ appPath: string; codexPath: string }> = [];
    for (const appPath of candidates) {
      const codexPath = join(appPath, 'Contents', 'Resources', 'codex');
      try {
        await access(codexPath, fsConstants.X_OK);
        found.push({ appPath, codexPath });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      throw new CliError(
        'CODEX_DESKTOP_AMBIGUOUS',
        `Multiple compatible macOS Desktop applications were found: ${found.map((item) => item.appPath).join(', ')}.`
      );
    }
    throw new CliError('CODEX_DESKTOP_NOT_FOUND', 'No supported macOS ChatGPT/Codex application bundle was found.');
  }

  private async removeMacActivation(stateOwned: boolean): Promise<void> {
    const launchAgentOwned = await isOwned(this.usagePaths.macLaunchAgentFile);
    const wrapperOwned = await isOwned(this.usagePaths.desktopWrapperFile);
    await assertOwnedOrMissing(this.usagePaths.macLaunchAgentFile);
    const current = await this.run('/bin/launchctl', ['getenv', 'CODEX_CLI_PATH']);
    if (current.code !== 0) {
      throw new CliError('CODEX_DESKTOP_REMOVAL_FAILED', current.stderr || 'Could not read CODEX_CLI_PATH.');
    }
    if (
      (launchAgentOwned || wrapperOwned || stateOwned) &&
      current.stdout.trim() === this.usagePaths.desktopWrapperFile
    ) {
      const unset = await this.run('/bin/launchctl', ['unsetenv', 'CODEX_CLI_PATH']);
      if (unset.code !== 0) {
        throw new CliError('CODEX_DESKTOP_REMOVAL_FAILED', unset.stderr || 'Could not unset CODEX_CLI_PATH.');
      }
    }
    await removeOwned(this.usagePaths.macLaunchAgentFile);
  }

  private async installLinuxActivation(appCommand: DesktopCommand): Promise<void> {
    await assertOwnedOrMissing(this.usagePaths.linuxDesktopEntryFile);
    const content = `[Desktop Entry]\n# ${MARKER}\nType=Application\nName=ChatGPT (Gateway)\nExec=${desktopQuote(appCommand, this.usagePaths.desktopWrapperFile)}\nTerminal=false\nCategories=Development;\n`;
    await atomicWrite(this.usagePaths.linuxDesktopEntryFile, content, 0o600);
    await this.refreshLinuxDesktopDatabase();
  }

  private async refreshLinuxDesktopDatabase(): Promise<void> {
    const lookup = await this.run('/usr/bin/env', ['sh', '-lc', 'command -v update-desktop-database']);
    const command = lookup.code === 0 ? lookup.stdout.trim() : '';
    if (command) await this.run(command, [dirname(this.usagePaths.linuxDesktopEntryFile)]);
  }

  private async discoverLinuxDesktopCommand(): Promise<DesktopCommand> {
    const candidates = new Map<string, DesktopCommand>();
    const addCandidate = (candidate: DesktopCommand) => {
      const key = JSON.stringify(effectiveDesktopCommand(candidate) ?? candidate);
      if (!candidates.has(key)) candidates.set(key, candidate);
    };
    for (const command of ['chatgpt', 'codex-desktop']) {
      const result = await this.run('/usr/bin/env', ['sh', '-lc', `command -v ${command}`]);
      if (result.code === 0 && result.stdout.trim()) {
        const candidate = { executable: result.stdout.trim(), args: [] };
        addCandidate(candidate);
      }
    }
    const dataDirectories = [
      this.options.env?.XDG_DATA_HOME || join(this.options.home ?? homedir(), '.local', 'share'),
      ...(this.options.env?.XDG_DATA_DIRS ?? '/usr/local/share:/usr/share').split(':').filter(Boolean),
    ];
    for (const dataDirectory of dataDirectories) {
      const applications = join(dataDirectory, 'applications');
      let entries: string[] = [];
      try {
        entries = await readdir(applications);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      for (const entry of entries.filter((value) => value.endsWith('.desktop'))) {
        const entryPath = join(applications, entry);
        if (entryPath === this.usagePaths.linuxDesktopEntryFile) continue;
        const content = await readFile(entryPath, 'utf8');
        if (content.includes(MARKER)) continue;
        if (!/^Name=.*(?:ChatGPT|Codex)/im.test(content)) continue;
        const exec = content.match(/^Exec=(.+)$/m)?.[1];
        if (!exec) continue;
        const candidate = parseDesktopCommand(exec);
        addCandidate(candidate);
      }
    }
    const values = [...candidates.values()];
    const compatible = values.filter((candidate) => !isContainerizedDesktopCommand(candidate));
    if (compatible.length === 1) return compatible[0];
    if (compatible.length > 1) {
      throw new CliError(
        'CODEX_DESKTOP_AMBIGUOUS',
        `Multiple compatible Linux Desktop commands were found: ${compatible.map(renderCommand).join(', ')}.`
      );
    }
    if (values.length > 0) {
      throw new CliError(
        'CODEX_DESKTOP_UNSUPPORTED_INSTALL',
        'Flatpak and Snap ChatGPT/Codex Desktop installations are not supported by the usage wrapper.'
      );
    }
    throw new CliError(
      'CODEX_DESKTOP_NOT_FOUND',
      'No compatible native or AppImage ChatGPT/Codex Desktop executable was found.'
    );
  }

  private async validateLinuxDesktopCommand(command: DesktopCommand): Promise<void> {
    const effective = effectiveDesktopExecutable(command);
    if (!effective) throw new CliError('CODEX_DESKTOP_NOT_FOUND', 'Could not resolve the Linux Desktop executable.');
    if (effective.includes('/')) {
      try {
        await access(effective, fsConstants.X_OK);
      } catch (error) {
        throw new CliError('CODEX_DESKTOP_NOT_FOUND', `Linux Desktop executable is not runnable: ${effective}`, {
          cause: error,
        });
      }
      return;
    }
    const result = await this.run('/usr/bin/env', ['sh', '-lc', `command -v ${shellQuote(effective)}`]);
    if (result.code !== 0 || !result.stdout.trim()) {
      throw new CliError('CODEX_DESKTOP_NOT_FOUND', `Linux Desktop executable was not found: ${effective}`);
    }
  }

  private async codexVersion(command: string, fallback: string): Promise<string> {
    const result = await this.run(command, ['--version']);
    return result.code === 0 ? (result.stdout.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/)?.[1] ?? fallback) : fallback;
  }

  private async protocolHash(realCodexPath: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-codex-schema-'));
    try {
      const result = await this.run(realCodexPath, [
        'app-server',
        'generate-json-schema',
        '--experimental',
        '--out',
        directory,
      ]);
      if (result.code !== 0) {
        throw new CliError(
          'CODEX_PROTOCOL_INCOMPATIBLE',
          result.stderr || 'Could not generate Codex app-server schema.'
        );
      }
      const files = [
        'v2/GetAccountRateLimitsResponse.json',
        'v2/GetAccountTokenUsageResponse.json',
        'v2/AccountRateLimitsUpdatedNotification.json',
      ];
      const contents = await Promise.all(files.map((file) => readFile(join(directory, file), 'utf8')));
      const combined = contents.join('\n');
      if (!combined.includes('rateLimitsByLimitId') || !combined.includes('dailyUsageBuckets')) {
        throw new CliError('CODEX_PROTOCOL_INCOMPATIBLE', 'Codex app-server usage schema is incompatible.');
      }
      return createHash('sha256').update(combined).digest('hex');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private run(command: string, args: string[]) {
    return (this.options.commandRunner ?? defaultRunner)(command, args, this.options.env);
  }
}

export async function readCodexUsageState(paths: CliPaths): Promise<CodexUsageState> {
  const state = await readState(resolveUsageComponentPaths(paths).stateFile);
  if (!state) throw new CliError('CODEX_USAGE_NOT_CONFIGURED', 'Codex usage components are not configured.');
  return state;
}

export function resolveUsageComponentPaths(paths: CliPaths, env: NodeJS.ProcessEnv = process.env, home = homedir()) {
  return {
    stateFile: join(paths.dataDir, 'codex-usage.json'),
    desktopWrapperFile: join(paths.runtimeDir, 'codex-desktop-wrapper'),
    gatewayCodexLauncherFile: join(home, '.local', 'bin', 'gateway-codex'),
    linuxDesktopEntryFile: join(
      env.XDG_DATA_HOME || join(home, '.local', 'share'),
      'applications',
      'chatgpt-gateway.desktop'
    ),
    macLaunchAgentFile: join(home, 'Library', 'LaunchAgents', 'net.wiolett.gateway.codex-usage.plist'),
  };
}

async function defaultRunner(command: string, args: string[], env?: NodeJS.ProcessEnv) {
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

async function readState(path: string): Promise<CodexUsageState | null> {
  try {
    return codexUsageStateSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readStateForUninstall(path: string): Promise<CodexUsageState | null> {
  try {
    return await readState(path);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) return null;
    throw error;
  }
}

async function writeState(path: string, state: CodexUsageState): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
  await chmod(path, mode);
}

async function assertOwnedOrMissing(path: string): Promise<void> {
  try {
    const content = await readFile(path, 'utf8');
    if (!content.includes(MARKER))
      throw new CliError('CODEX_USAGE_ARTIFACT_CONFLICT', `Refusing to overwrite ${path}.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

async function isOwned(path: string): Promise<boolean> {
  try {
    return (await readFile(path, 'utf8')).includes(MARKER);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function removeOwned(path: string): Promise<void> {
  try {
    const content = await readFile(path, 'utf8');
    if (!content.includes(MARKER)) throw new CliError('CODEX_USAGE_ARTIFACT_CONFLICT', `Refusing to remove ${path}.`);
    await rm(path, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function desktopQuote(appCommand: DesktopCommand, wrapper: string): string {
  return ['/usr/bin/env', `CODEX_CLI_PATH=${wrapper}`, appCommand.executable, ...appCommand.args]
    .map(desktopArg)
    .join(' ');
}

function parseDesktopCommand(command: string): DesktopCommand {
  const tokens = shellWords(command).filter((token) => {
    if (/^%[fFuUdDnNickvm]$/.test(token)) return false;
    if (/%[fFuUdDnNickvm]/.test(token)) {
      throw new CliError('CODEX_DESKTOP_UNSUPPORTED_EXEC', `Unsupported Desktop Exec field code in ${token}.`);
    }
    return true;
  });
  if (tokens.length === 0) throw new CliError('CODEX_DESKTOP_NOT_FOUND', 'Desktop Exec command is empty.');
  return { executable: tokens[0], args: tokens.slice(1) };
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaped = false;
  for (const character of command.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== 'single') {
      escaped = true;
      continue;
    }
    if (character === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
      continue;
    }
    if (character === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      continue;
    }
    if (/\s/.test(character) && quote === null) {
      if (current) words.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (escaped || quote)
    throw new CliError('CODEX_DESKTOP_UNSUPPORTED_EXEC', 'Desktop Exec command has invalid quoting.');
  if (current) words.push(current);
  return words;
}

function effectiveDesktopExecutable(command: DesktopCommand): string | null {
  return effectiveDesktopCommand(command)?.executable ?? null;
}

function effectiveDesktopCommand(command: DesktopCommand): DesktopCommand | null {
  if (basename(command.executable) !== 'env') return command;
  for (let index = 0; index < command.args.length; index += 1) {
    const value = command.args[index];
    if (value === '-u' || value === '--unset') {
      index += 1;
      continue;
    }
    if (value === '-S' || value === '--split-string') return null;
    if (value.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) continue;
    return { executable: value, args: command.args.slice(index + 1) };
  }
  return null;
}

function isContainerizedDesktopCommand(command: DesktopCommand): boolean {
  const effective = effectiveDesktopExecutable(command);
  if (!effective) return true;
  const name = basename(effective);
  return name === 'flatpak' || name === 'snap' || effective.includes('/flatpak/') || effective.includes('/snap/');
}

function renderCommand(command: DesktopCommand): string {
  return [command.executable, ...command.args].join(' ');
}

function desktopArg(value: string): string {
  if (/^[A-Za-z0-9_./:=+,-]+$/.test(value)) return value;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$')}"`;
}

function macAppFromCodexPath(path: string): string | null {
  const suffix = '/Contents/Resources/codex';
  return path.endsWith(suffix) && path.slice(0, -suffix.length).endsWith('.app') ? path.slice(0, -suffix.length) : null;
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
