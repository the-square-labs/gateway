import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexIntegrationService, type CommandRunner } from './codex-integration.js';
import { type CredentialStore, confirmFileCredentialFallback, SecureCredentialStore } from './credentials.js';
import { CLI_VERSION } from './discovery.js';
import { CliError, errorPayload } from './errors.js';
import type { Fetch } from './http.js';
import { runInferenceMcp } from './inference-mcp.js';
import {
  type InteractiveCommandInput,
  runInteractiveHarnessSetupCommand,
  runInteractiveInferenceCommand,
  runInteractiveRootCommand,
} from './interactive-command.js';
import { createInteractiveCliUi, type InteractiveCliUi } from './interactive-ui.js';
import { loginCommand, logoutCommand } from './login-command.js';
import { createOutput, type Output } from './output.js';
import { type CliPaths, resolveCliPaths } from './paths.js';
import { ProfileStore } from './profiles.js';
import { authenticatedSetupClient } from './session.js';
import type { InferenceSetupClient } from './tokens.js';
import type { InferenceDiscovery } from './types.js';

interface ParsedArgs {
  command: string[];
  profile?: string;
  gateway?: string;
  json: boolean;
  allowFileCredentials: boolean;
  replace: boolean;
  revokeToken: boolean;
  deviceName?: string;
  harness?: string;
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
}

const HELP = `Usage: npx @wiolett/gateway [options] [command]

Commands:
  login [GATEWAY]                  Authorize a Gateway profile in the browser
  logout                          Revoke and remove profile authorization
  status                          Show Gateway profile and authorization status
  inference                       Open the interactive Inference menu
  inference tokens list           List active package-issued inference tokens
  inference tokens create         Create a Codex inference token
  inference tokens revoke ID      Revoke an owned inference token
  inference setup                 Interactively authorize and configure a harness
  inference setup codex           Configure Codex without interactive prompts
  inference sync codex            Refresh the authoritative Codex model catalog
  inference doctor codex          Diagnose the Codex integration
  inference remove codex          Remove package-managed Codex configuration
  inference mcp                    Run the Codex lifecycle MCP server (stdio)

Options:
  --profile NAME                  Use a named profile (default: active or "default")
  --gateway URL                   Gateway origin for login
  --json                          Emit credential-redacted JSON
  --allow-file-credentials        Allow a mode-0600 credential file fallback
  --device-name NAME              Device label for token creation
  --harness NAME                  Harness for token creation (codex in v1)
  --replace                       Explicitly replace an existing matching token
  --revoke-token                  Revoke the runtime token while removing a harness
  -h, --help                      Show help
  -v, --version                   Show version`;

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: [],
    json: false,
    allowFileCredentials: false,
    replace: false,
    revokeToken: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const next = () => {
      const item = args[++index];
      if (!item) throw new CliError('INVALID_ARGUMENT', `Option ${value} requires a value.`);
      return item;
    };
    if (value === '--profile') parsed.profile = next();
    else if (value === '--gateway') parsed.gateway = next();
    else if (value === '--device-name') parsed.deviceName = next();
    else if (value === '--name') parsed.deviceName = next();
    else if (value === '--harness') parsed.harness = next();
    else if (value === '--json') parsed.json = true;
    else if (value === '--allow-file-credentials') parsed.allowFileCredentials = true;
    else if (value === '--replace') parsed.replace = true;
    else if (value === '--revoke-token') parsed.revokeToken = true;
    else if (value === '--help' || value === '-h') parsed.command = ['help'];
    else if (value === '--version' || value === '-v') parsed.command = ['version'];
    else if (value.startsWith('-')) throw new CliError('INVALID_ARGUMENT', `Unknown option: ${value}`);
    else parsed.command.push(value);
  }
  return parsed;
}

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const parsed = parseArgs(args);
  const paths = dependencies.paths ?? resolveCliPaths();
  const profiles = dependencies.profiles ?? new ProfileStore(paths.profilesFile);
  const interactive = dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const credentials =
    dependencies.credentials ??
    SecureCredentialStore.forPlatform(paths.fileCredentialsFile, paths.dataDir, {
      allowFileCredentials: parsed.allowFileCredentials,
      interactive,
      confirmFileFallback: () => confirmFileCredentialFallback(paths.fileCredentialsFile),
    });
  const output = dependencies.output ?? createOutput(parsed.json);
  const fetcher = dependencies.fetch;

  try {
    if (parsed.command[0] === 'help') {
      output.write({ help: HELP }, () => HELP);
      return 0;
    }
    if (parsed.command[0] === 'version') {
      output.write({ version: CLI_VERSION }, () => CLI_VERSION);
      return 0;
    }
    const profileName = await profiles.resolveName(parsed.profile);
    const menu = () => interactiveCommandInput(parsed, profileName, paths, profiles, credentials, dependencies);
    if (parsed.command.length === 0) {
      if (!interactive || output.json) {
        output.write({ help: HELP }, () => HELP);
        return 0;
      }
      return await runInteractiveRootCommand(menu());
    }
    if (parsed.command[0] === 'login') {
      await loginCommand(parsed, profileName, profiles, credentials, output, fetcher, dependencies.openBrowser);
      return 0;
    }
    if (parsed.command[0] === 'logout') {
      await logoutCommand(profileName, profiles, credentials, output, fetcher);
      return 0;
    }
    if (parsed.command[0] === 'status') {
      await statusCommand(profileName, profiles, credentials, output, fetcher);
      return 0;
    }
    if (parsed.command[0] === 'inference' && parsed.command[1] === 'tokens') {
      await tokensCommand(parsed, profileName, profiles, credentials, output, fetcher);
      return 0;
    }
    if (parsed.command[0] === 'inference') {
      if (parsed.command.length === 1) {
        if (!interactive || output.json) {
          throw new CliError('INTERACTIVE_TTY_REQUIRED', 'Run this command in a TTY or specify a subcommand.');
        }
        return await runInteractiveInferenceCommand(menu());
      }
      return await codexCommand(parsed, profileName, profiles, credentials, output, interactive, dependencies);
    }
    throw new CliError('UNKNOWN_COMMAND', `Unknown command: ${parsed.command.join(' ')}`);
  } catch (error) {
    const payload = errorPayload(error);
    if (
      parsed.command[0] === 'inference' &&
      (parsed.command[1] === 'mcp' || (parsed.command[1] === 'auth' && parsed.command[2] === 'codex'))
    ) {
      process.stderr.write(`Error [${payload.error.code}]: ${payload.error.message}\n`);
      return error instanceof CliError ? error.exitCode : 1;
    }
    output.write(payload, () => `Error [${payload.error.code}]: ${payload.error.message}`);
    return error instanceof CliError ? error.exitCode : 1;
  }
}

async function statusCommand(
  profileName: string,
  profiles: ProfileStore,
  credentials: CredentialStore,
  output: Output,
  fetcher?: Fetch
) {
  const profile = await profiles.get(profileName);
  if (!profile) {
    output.write(
      { ok: true, profile: profileName, state: 'not_configured' },
      () => `Profile "${profileName}" is not configured.`
    );
    return;
  }
  try {
    const { client, discovery } = await authenticatedSetupClient(profileName, profiles, credentials, fetcher);
    const identity = await client.me();
    const tokens = await client.listTokens();
    output.write(
      {
        ok: true,
        profile: profileName,
        gateway: profile.origin,
        state: 'authenticated',
        user: identity.user,
        inference: identity.inference,
        catalogVersion: identity.catalogVersion,
        adapters: discovery.adapters,
        harnesses: discovery.harnesses,
        tokens,
      },
      () => `Authenticated to ${profile.origin} as ${identity.user.email}. Inference setup is allowed.`
    );
  } catch (error) {
    if (error instanceof CliError && ['NETWORK_ERROR', 'NETWORK_TIMEOUT'].includes(error.code)) {
      output.write(
        { ok: true, profile: profileName, gateway: profile.origin, state: 'offline' },
        () => `Gateway ${profile.origin} is offline. Local authorization was not changed.`
      );
      return;
    }
    if (error instanceof CliError && error.code === 'INFERENCE_DISABLED') {
      output.write(
        { ok: true, profile: profileName, gateway: profile.origin, state: 'inference_disabled' },
        () => `Inference is disabled on ${profile.origin}. Local authorization was not changed.`
      );
      return;
    }
    throw error;
  }
}

async function tokensCommand(
  args: ParsedArgs,
  profileName: string,
  profiles: ProfileStore,
  credentials: CredentialStore,
  output: Output,
  fetcher?: Fetch
) {
  const action = args.command[2];
  const { client } = await authenticatedSetupClient(profileName, profiles, credentials, fetcher);
  if (action === 'list') {
    const tokens = await client.listTokens();
    output.write({ ok: true, profile: profileName, data: tokens }, () => formatTokenList(tokens));
    return;
  }
  if (action === 'create') {
    if (args.harness && args.harness !== 'codex') {
      throw new CliError('UNSUPPORTED_HARNESS', 'Only the codex harness is supported in this release.');
    }
    const profile = await profiles.getRequired(profileName);
    const created = await client.createToken({
      installationId: profile.installationId,
      deviceName: args.deviceName,
      replaceExisting: args.replace,
    });
    output.write(
      { ok: true, profile: profileName, data: created },
      () =>
        `Created ${created.name} (${created.prefix}).\nToken (shown once): ${created.token}\nStore it securely; it cannot be retrieved again.`
    );
    return;
  }
  if (action === 'revoke') {
    const id = args.command[3];
    if (!id) throw new CliError('TOKEN_ID_REQUIRED', 'Usage: inference tokens revoke ID');
    await client.revokeToken(id);
    output.write({ ok: true, profile: profileName, revoked: id }, () => `Revoked inference token ${id}.`);
    return;
  }
  throw new CliError('UNKNOWN_COMMAND', 'Usage: inference tokens list|create|revoke');
}

async function codexCommand(
  args: ParsedArgs,
  profileName: string,
  profiles: ProfileStore,
  credentials: CredentialStore,
  output: Output,
  interactive: boolean,
  dependencies: CliDependencies
): Promise<number> {
  const action = args.command[1];
  const harness = args.command[2];
  if (action === 'mcp' && args.command.length === 2) {
    await runInferenceMcp({
      profileName,
      paths: dependencies.paths ?? resolveCliPaths(),
      profiles,
      credentials,
      fetch: dependencies.fetch,
    });
    return 0;
  }
  if (action === 'setup' && harness === undefined) {
    if (!interactive || output.json) {
      throw new CliError(
        'HARNESS_REQUIRED',
        'Interactive setup requires a TTY. For automation, use: inference setup codex'
      );
    }
    return runInteractiveHarnessSetupCommand(
      interactiveCommandInput(
        args,
        profileName,
        dependencies.paths ?? resolveCliPaths(),
        profiles,
        credentials,
        dependencies
      )
    );
  }
  const integration = new CodexIntegrationService(dependencies.paths ?? resolveCliPaths(), credentials, {
    fetch: dependencies.fetch,
    commandRunner: dependencies.commandRunner,
    runtimeSource: dependencies.runtimeSource,
    env: dependencies.env,
    home: dependencies.home,
  });
  if (action === 'auth' && harness === 'codex') {
    const token = await integration.printRuntimeToken(profileName);
    output.write({ token }, () => token);
    return 0;
  }
  if (!['setup', 'sync', 'doctor', 'remove'].includes(action ?? '') || harness !== 'codex') {
    throw new CliError('UNKNOWN_COMMAND', 'Usage: inference setup|sync|doctor|remove codex');
  }

  if (action === 'doctor') {
    let discovery: InferenceDiscovery | undefined;
    let setupCheck: { status: 'ok' | 'error' | 'warning'; message: string } | undefined;
    try {
      const context = await authenticatedSetupClient(profileName, profiles, credentials, dependencies.fetch);
      await context.client.me();
      discovery = context.discovery;
      setupCheck = { status: 'ok', message: 'Gateway accepted the setup authorization' };
    } catch (error) {
      const offline = error instanceof CliError && ['NETWORK_ERROR', 'NETWORK_TIMEOUT'].includes(error.code);
      setupCheck = {
        status: offline ? 'warning' : 'error',
        message: `${offline ? 'Offline' : 'Setup authorization failed'}: ${errorPayload(error).error.message}`,
      };
    }
    const report = await integration.doctor({ profileName, discovery, setupCheck });
    output.write(report, () =>
      report.checks.map((check) => `${check.status.toUpperCase()}\t${check.name}\t${check.message}`).join('\n')
    );
    return report.ok ? 0 : 1;
  }

  if (action === 'setup') {
    let profile = await profiles.get(profileName);
    if (!profile?.clientId) {
      await loginCommand(
        args,
        profileName,
        profiles,
        credentials,
        output,
        dependencies.fetch,
        dependencies.openBrowser
      );
      profile = await profiles.getRequired(profileName);
    }
    const context = await authenticatedSetupClient(profileName, profiles, credentials, dependencies.fetch);
    await context.client.me();
    const result = await integration.setup({
      profileName,
      profile,
      discovery: context.discovery,
      client: context.client,
    });
    output.write({ ok: true, ...result }, () =>
      [
        `Configured Codex ${result.codexVersion} for Gateway profile "${profileName}".`,
        `Models: ${result.catalog.modelCount}; catalog changes apply to the next Codex process.`,
        `Config: ${result.configFile}`,
      ].join('\n')
    );
    return 0;
  }

  if (action === 'sync') {
    const context = await authenticatedSetupClient(profileName, profiles, credentials, dependencies.fetch);
    const result = await integration.sync({ profileName, discovery: context.discovery });
    output.write(
      { ok: true, ...result },
      () => `Codex catalog ${result.status} (${result.modelCount} models); changes apply to the next Codex process.`
    );
    return 0;
  }
  const client = args.revokeToken
    ? (await authenticatedSetupClient(profileName, profiles, credentials, dependencies.fetch)).client
    : undefined;
  const result = await integration.remove({
    profileName,
    removeToken: args.revokeToken,
    client,
  });
  output.write({ ok: true, ...result }, () =>
    result.conflicts.length
      ? `Removed owned Codex files; preserved edited config blocks: ${result.conflicts.join(', ')}.`
      : `Removed the Codex integration for Gateway profile "${profileName}".`
  );
  return result.conflicts.length ? 1 : 0;
}

function formatTokenList(tokens: Awaited<ReturnType<InferenceSetupClient['listTokens']>>): string {
  if (tokens.length === 0) return 'No active package-issued inference tokens.';
  return tokens
    .map((token) => `${token.id}\t${token.prefix}\t${token.harness}\t${token.deviceName}\t${token.createdAt}`)
    .join('\n');
}

function interactiveCommandInput(
  args: ParsedArgs,
  profileName: string,
  paths: CliPaths,
  profiles: ProfileStore,
  credentials: CredentialStore,
  dependencies: CliDependencies
): InteractiveCommandInput {
  return {
    profileName,
    profileExplicit: args.profile !== undefined,
    gateway: args.gateway,
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
  };
}

export function isDirectCliInvocation(moduleUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  if (['gateway', 'gateway.cmd'].includes(basename(argvEntry))) return true;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvEntry);
  } catch {
    return fileURLToPath(moduleUrl) === argvEntry;
  }
}

if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  process.exitCode = await runCli(process.argv.slice(2));
}
