import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexIntegrationService, type CommandRunner } from './codex-integration.js';
import { type CredentialStore, SecureCredentialStore } from './credentials.js';
import { CLI_VERSION } from './discovery.js';
import { CliError, errorPayload } from './errors.js';
import type { Fetch } from './http.js';
import { runInferenceMcp } from './inference-mcp.js';
import { type InferenceProxyDaemonManager, runInferenceProxyDaemon } from './inference-proxy-daemon.js';
import {
  type InteractiveCommandInput,
  runInteractiveHarnessSetupCommand,
  runInteractiveRootCommand,
} from './interactive-command.js';
import { isAuthorizationRequired } from './interactive-setup.js';
import { createInteractiveCliUi, type InteractiveCliUi } from './interactive-ui.js';
import { loginCommand, logoutCommand } from './login-command.js';
import { createOutput, type Output } from './output.js';
import { type CliPaths, resolveCliPaths } from './paths.js';
import { ProfileStore } from './profiles.js';
import { authenticatedSetupClient } from './session.js';

interface ParsedArgs {
  command: string[];
}

interface CliDependencies {
  paths?: CliPaths;
  profiles?: ProfileStore;
  credentials?: CredentialStore;
  fetch?: Fetch;
  output?: Output;
  interactive?: boolean;
  openBrowser?: (url: string) => Promise<void>;
  commandRunner?: CommandRunner;
  runtimeSource?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  interactiveUi?: InteractiveCliUi;
  proxyDaemon?: InferenceProxyDaemonManager;
}

const CONNECTION_NAME = 'default';

const HELP = `Usage: npx @wiolett/gateway-inference [command]

Commands:
  login [GATEWAY]                  Authorize this device through Gateway
  logout                           Remove Gateway setup authorization
  setup [HARNESS]                  Configure an inference harness

Running without a command opens the interactive manager.

Options:
  -h, --help                       Show help
  -v, --version                    Show version`;

function parseArgs(args: string[]): ParsedArgs {
  const command: string[] = [];
  for (const value of args) {
    if (value === '--help' || value === '-h') return { command: ['help'] };
    if (value === '--version' || value === '-v') return { command: ['version'] };
    if (value.startsWith('-')) throw new CliError('INVALID_ARGUMENT', `Unknown option: ${value}`);
    command.push(value);
  }
  return { command };
}

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const output = dependencies.output ?? createOutput(false);
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    const payload = errorPayload(error);
    output.write(payload, () => `Error [${payload.error.code}]: ${payload.error.message}`);
    return error instanceof CliError ? error.exitCode : 1;
  }
  const paths = dependencies.paths ?? resolveCliPaths();
  const profiles = dependencies.profiles ?? new ProfileStore(paths.profilesFile);
  const interactive = dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const interactiveUi = dependencies.interactiveUi ?? (interactive ? createInteractiveCliUi() : undefined);
  const credentials =
    dependencies.credentials ??
    SecureCredentialStore.forPlatform(paths.fileCredentialsFile, paths.dataDir, {
      allowFileCredentials: false,
      interactive: interactive && process.platform !== 'darwin',
      confirmFileFallback: interactiveUi
        ? async () =>
            (await interactiveUi.confirm(
              `No OS credential store is available. Store credentials in ${paths.fileCredentialsFile} with mode 0600?`
            )) === true
        : undefined,
    });
  const input = interactiveCommandInput(paths, profiles, credentials, {
    ...dependencies,
    interactiveUi,
  });
  const privateRuntime = parsed.command[0]?.startsWith('__') ?? false;

  try {
    if (parsed.command[0] === 'help') {
      output.write({ help: HELP }, () => HELP);
      return 0;
    }
    if (parsed.command[0] === 'version') {
      output.write({ version: CLI_VERSION }, () => CLI_VERSION);
      return 0;
    }
    if (parsed.command[0] === '__mcp' && parsed.command.length === 1) {
      await runInferenceMcp({
        profileName: CONNECTION_NAME,
        paths,
        profiles,
        credentials,
        fetch: dependencies.fetch,
      });
      return 0;
    }
    if (parsed.command[0] === '__proxy' && parsed.command.length === 1) {
      await runInferenceProxyDaemon({
        profileName: CONNECTION_NAME,
        paths,
        credentials,
      });
      return 0;
    }
    if (parsed.command.length === 0) {
      if (!interactive) {
        throw new CliError(
          'INTERACTIVE_TTY_REQUIRED',
          'Interactive mode requires a TTY. Use login GATEWAY, logout, or setup HARNESS.'
        );
      }
      return await runInteractiveRootCommand(input);
    }
    if (parsed.command[0] === 'login') {
      if (parsed.command.length > 2) throw new CliError('INVALID_ARGUMENT', 'Usage: login [GATEWAY]');
      let gateway: string | undefined = parsed.command[1];
      if (!gateway && interactive) {
        input.ui.intro('Wiolett Gateway Inference · Login');
        gateway = (await input.ui.gatewayOrigin()) ?? undefined;
        if (!gateway) {
          input.ui.cancel('Login cancelled.');
          return 0;
        }
      }
      if (!gateway) {
        throw new CliError('GATEWAY_REQUIRED', 'Provide a Gateway URL or run login in an interactive terminal.');
      }
      await loginCommand(
        { gateway, command: ['login'] },
        CONNECTION_NAME,
        profiles,
        credentials,
        output,
        dependencies.fetch,
        dependencies.openBrowser
      );
      return 0;
    }
    if (parsed.command[0] === 'logout') {
      if (parsed.command.length !== 1) throw new CliError('INVALID_ARGUMENT', 'Usage: logout');
      await logoutCommand(CONNECTION_NAME, profiles, credentials, output, dependencies.fetch);
      return 0;
    }
    if (parsed.command[0] === 'setup') {
      if (parsed.command.length > 2) throw new CliError('INVALID_ARGUMENT', 'Usage: setup [HARNESS]');
      const harness = parsed.command[1];
      if (!harness) {
        if (!interactive) {
          throw new CliError('HARNESS_REQUIRED', 'Interactive setup requires a TTY. For automation, use: setup codex');
        }
        return await runInteractiveHarnessSetupCommand(input);
      }
      if (harness !== 'codex') {
        throw new CliError('UNSUPPORTED_HARNESS', `Harness ${harness} is not supported by this CLI version.`);
      }
      return await setupCodexCommand(input, paths, profiles, credentials, output, interactive, dependencies);
    }
    throw new CliError('UNKNOWN_COMMAND', `Unknown command: ${parsed.command.join(' ')}`);
  } catch (error) {
    const payload = errorPayload(error);
    if (privateRuntime) {
      process.stderr.write(`Error [${payload.error.code}]: ${payload.error.message}\n`);
      return error instanceof CliError ? error.exitCode : 1;
    }
    output.write(payload, () => `Error [${payload.error.code}]: ${payload.error.message}`);
    return error instanceof CliError ? error.exitCode : 1;
  }
}

async function setupCodexCommand(
  input: InteractiveCommandInput,
  paths: CliPaths,
  profiles: ProfileStore,
  credentials: CredentialStore,
  output: Output,
  interactive: boolean,
  dependencies: CliDependencies
): Promise<number> {
  let profile = await profiles.get(CONNECTION_NAME);
  let context: Awaited<ReturnType<typeof authenticatedSetupClient>>;
  try {
    context = await authenticatedSetupClient(CONNECTION_NAME, profiles, credentials, dependencies.fetch);
  } catch (error) {
    if (!isAuthorizationRequired(error)) throw error;
    let gateway = profile?.origin;
    if (!gateway && interactive) gateway = (await input.ui.gatewayOrigin()) ?? undefined;
    if (!gateway) {
      throw new CliError('GATEWAY_REQUIRED', 'Log in first or run this command in a TTY to enter the Gateway URL.');
    }
    await loginCommand(
      { gateway, command: ['login'] },
      CONNECTION_NAME,
      profiles,
      credentials,
      output,
      dependencies.fetch,
      dependencies.openBrowser
    );
    profile = await profiles.getRequired(CONNECTION_NAME);
    context = await authenticatedSetupClient(CONNECTION_NAME, profiles, credentials, dependencies.fetch);
  }
  profile ??= await profiles.getRequired(CONNECTION_NAME);
  await context.client.me();
  const result = await createIntegration(paths, credentials, dependencies).setup({
    profileName: CONNECTION_NAME,
    profile,
    discovery: context.discovery,
    client: context.client,
  });
  output.write({ ok: true, ...result }, () =>
    [
      `Configured Codex ${result.codexVersion}.`,
      `Models: ${result.catalog.modelCount}; default: ${result.defaultModel}.`,
      ...(result.warning ? [`Warning: ${result.warning}`] : []),
      'Fully quit and reopen Codex to load the current model catalog.',
      `Config: ${result.configFile}`,
    ].join('\n')
  );
  return 0;
}

function createIntegration(paths: CliPaths, credentials: CredentialStore, dependencies: CliDependencies) {
  return new CodexIntegrationService(paths, credentials, {
    fetch: dependencies.fetch,
    commandRunner: dependencies.commandRunner,
    runtimeSource: dependencies.runtimeSource,
    env: dependencies.env,
    home: dependencies.home,
    proxyDaemon: dependencies.proxyDaemon,
  });
}

function interactiveCommandInput(
  paths: CliPaths,
  profiles: ProfileStore,
  credentials: CredentialStore,
  dependencies: CliDependencies
): InteractiveCommandInput {
  return {
    profileName: CONNECTION_NAME,
    paths,
    profiles,
    credentials,
    ui: dependencies.interactiveUi ?? createInteractiveCliUi(),
    fetch: dependencies.fetch,
    openBrowser: dependencies.openBrowser,
    commandRunner: dependencies.commandRunner,
    runtimeSource: dependencies.runtimeSource,
    env: dependencies.env,
    home: dependencies.home,
    proxyDaemon: dependencies.proxyDaemon,
  };
}

export function isDirectCliInvocation(moduleUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  if (['gateway-inference', 'gateway-inference.cmd'].includes(basename(argvEntry))) return true;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvEntry);
  } catch {
    return fileURLToPath(moduleUrl) === argvEntry;
  }
}

if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  process.exitCode = await runCli(process.argv.slice(2));
}
