import { readVisibleCatalogModels } from './codex-catalog.js';
import { inspectCodexConfiguration, resolveCodexPaths } from './codex-config.js';
import { CodexIntegrationService, type CommandRunner } from './codex-integration.js';
import type { CredentialStore } from './credentials.js';
import { CliError, errorPayload } from './errors.js';
import type { Fetch } from './http.js';
import type { InferenceProxyDaemonManager } from './inference-proxy-daemon.js';
import { isAuthorizationRequired, runInteractiveInferenceSetup } from './interactive-setup.js';
import type { InteractiveCliUi, InteractiveOption } from './interactive-ui.js';
import { loginCommand, logoutCommand } from './login-command.js';
import type { Output } from './output.js';
import type { CliPaths } from './paths.js';
import type { ProfileStore } from './profiles.js';
import { authenticatedSetupClient } from './session.js';
import type { InferenceSetupClient } from './tokens.js';
import type { InferenceDiscovery, SetupIdentity } from './types.js';

export interface InteractiveCommandInput {
  profileName: string;
  paths: CliPaths;
  profiles: ProfileStore;
  credentials: CredentialStore;
  ui: InteractiveCliUi;
  fetch?: Fetch;
  openBrowser?: (url: string) => Promise<void>;
  commandRunner?: CommandRunner;
  runtimeSource?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  proxyDaemon?: InferenceProxyDaemonManager;
}

interface InteractiveState {
  identity?: SetupIdentity;
  harnessConfigured: boolean;
  models: string[];
}

type InferenceAction = 'authenticate' | 'setup' | 'sync' | 'doctor' | 'remove' | 'logout';

export async function runInteractiveRootCommand(input: InteractiveCommandInput): Promise<number> {
  input.ui.intro('Wiolett Gateway Inference');
  return runInteractiveInferenceCommand(input, false);
}

export async function runInteractiveInferenceCommand(
  input: InteractiveCommandInput,
  showIntro = true
): Promise<number> {
  if (showIntro) input.ui.intro('Wiolett Gateway Inference');
  const integration = createIntegration(input);
  const state = await loadInferenceMenuState(input);
  await showState(input, state);

  while (true) {
    const action = (await input.ui.select(
      'What do you want to do?',
      inferenceActions(state.identity, state.harnessConfigured, state.models.length)
    )) as InferenceAction | null;
    if (!action) {
      input.ui.cancel('No action selected.');
      return 0;
    }

    if (action === 'authenticate') {
      const identity = await authenticate(input);
      if (!identity) return 0;
      state.identity = identity;
      showAccount(input.ui, identity);
      continue;
    }
    if (action === 'logout') return logout(input);
    if (action === 'setup') return setupHarness(input, integration);
    if (action === 'sync') {
      state.models = await syncModels(input, integration);
      continue;
    }
    if (action === 'doctor') {
      await diagnose(input, integration);
      continue;
    }
    if (await removeHarness(input, integration)) {
      state.harnessConfigured = false;
      state.models = [];
    }
  }
}

export async function runInteractiveHarnessSetupCommand(input: InteractiveCommandInput): Promise<number> {
  input.ui.intro('Wiolett Gateway Inference · Setup');
  return setupHarness(input, createIntegration(input));
}

async function loadInferenceMenuState(input: InteractiveCommandInput): Promise<InteractiveState> {
  let identity: SetupIdentity | undefined;
  const profile = await input.profiles.get(input.profileName);
  if (profile) {
    try {
      const context = await authenticatedSetupClient(input.profileName, input.profiles, input.credentials, input.fetch);
      identity = await context.client.me();
    } catch (error) {
      if (!isAuthorizationRequired(error)) throw error;
    }
  }

  const paths = resolveCodexPaths(input.paths, input.profileName, input.env, input.home);
  const config = await inspectCodexConfiguration({ paths, profile: input.profileName });
  const models = config.configured ? await readVisibleCatalogModels(paths.catalogFile) : [];
  return { identity, harnessConfigured: config.configured, models };
}

async function showState(input: InteractiveCommandInput, state: InteractiveState): Promise<void> {
  const profile = await input.profiles.get(input.profileName);
  if (profile) input.ui.info(`Gateway: ${profile.origin}`);
  if (state.identity) showAccount(input.ui, state.identity);
  input.ui.info(
    state.harnessConfigured ? `Codex: configured · ${state.models.length} models` : 'Codex: not configured'
  );
}

function inferenceActions(
  identity: SetupIdentity | undefined,
  harnessConfigured: boolean,
  modelCount: number
): InteractiveOption[] {
  const options: InteractiveOption[] = [];
  if (!identity) {
    options.push({
      value: 'authenticate',
      label: 'Login',
      hint: 'Authorize this device through Gateway OAuth',
    });
  }
  options.push({
    value: 'setup',
    label: harnessConfigured ? 'Setup or repair harness' : 'Setup harness',
    hint: harnessConfigured ? 'Reconfigure the managed Codex integration' : 'Configure a supported inference harness',
  });
  if (harnessConfigured) {
    if (identity) {
      options.push({
        value: 'sync',
        label: 'Refresh models',
        hint: `${modelCount} models currently cached`,
      });
    }
    options.push(
      {
        value: 'doctor',
        label: 'Check integration',
        hint: 'Diagnose Codex, credentials, configuration, and catalog',
      },
      {
        value: 'remove',
        label: 'Remove Codex integration',
        hint: 'Delete only package-managed configuration and credentials',
      }
    );
  }
  if (identity) {
    options.push({
      value: 'logout',
      label: 'Logout',
      hint: `Remove setup authorization for ${identity.user.email}`,
    });
  }
  return options;
}

async function authenticate(input: InteractiveCommandInput): Promise<SetupIdentity | null> {
  const existing = await input.profiles.get(input.profileName);
  const gateway = existing?.origin ?? (await input.ui.gatewayOrigin());
  if (!gateway) {
    input.ui.cancel('Login cancelled.');
    return null;
  }
  input.ui.info('Complete authorization in your browser...');
  try {
    await loginCommand(
      { gateway, command: ['login'] },
      input.profileName,
      input.profiles,
      input.credentials,
      SILENT_OUTPUT,
      input.fetch,
      input.openBrowser
    );
    const context = await authenticatedSetupClient(input.profileName, input.profiles, input.credentials, input.fetch);
    const identity = await context.client.me();
    input.ui.info('Gateway authorization complete');
    return identity;
  } catch (error) {
    input.ui.info('Gateway authorization failed');
    throw error;
  }
}

function showAccount(ui: InteractiveCliUi, identity: SetupIdentity): void {
  const name = identity.user.name?.trim();
  ui.info(`Account: ${identity.user.email}${name ? ` (${name})` : ''} ${identity.user.role}`);
}

async function syncModels(input: InteractiveCommandInput, integration: CodexIntegrationService): Promise<string[]> {
  const spinner = input.ui.spinner('Refreshing Gateway models...');
  try {
    const context = await authenticatedSetupClient(input.profileName, input.profiles, input.credentials, input.fetch);
    const result = await integration.sync({ profileName: input.profileName, discovery: context.discovery });
    const paths = resolveCodexPaths(input.paths, input.profileName, input.env, input.home);
    const models = await readVisibleCatalogModels(paths.catalogFile);
    spinner.stop(`Model catalog ${result.status} · ${models.length} models`);
    return models;
  } catch (error) {
    spinner.error('Could not refresh the model catalog');
    throw error;
  }
}

async function diagnose(input: InteractiveCommandInput, integration: CodexIntegrationService): Promise<void> {
  let discovery: InferenceDiscovery | undefined;
  let setupCheck: { status: 'ok' | 'error' | 'warning'; message: string } | undefined;
  try {
    const context = await authenticatedSetupClient(input.profileName, input.profiles, input.credentials, input.fetch);
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
  const spinner = input.ui.spinner('Checking the Codex integration...');
  try {
    const report = await integration.doctor({ profileName: input.profileName, discovery, setupCheck });
    spinner.stop(report.ok ? 'Integration check complete' : 'Integration needs attention');
    for (const check of report.checks) {
      input.ui.info(`${check.status.toUpperCase()} · ${check.name}: ${check.message}`);
    }
  } catch (error) {
    spinner.error('Could not check the Codex integration');
    throw error;
  }
}

async function removeHarness(input: InteractiveCommandInput, integration: CodexIntegrationService): Promise<boolean> {
  const confirmed = await input.ui.confirm('Remove the package-managed Codex integration from this device?');
  if (!confirmed) {
    if (confirmed === null) input.ui.cancel('Removal cancelled.');
    return false;
  }
  let client: InferenceSetupClient | undefined;
  try {
    client = (await authenticatedSetupClient(input.profileName, input.profiles, input.credentials, input.fetch)).client;
  } catch (error) {
    const expected =
      isAuthorizationRequired(error) ||
      (error instanceof CliError && ['NETWORK_ERROR', 'NETWORK_TIMEOUT'].includes(error.code));
    if (!expected) throw error;
  }
  const spinner = input.ui.spinner('Removing the Codex integration...');
  try {
    const result = await integration.remove({
      profileName: input.profileName,
      removeToken: Boolean(client),
      client,
    });
    if (!result.removed) {
      spinner.error('Codex integration was not removed');
      if (result.conflicts.length > 0) {
        input.ui.info(`Preserved conflicting configuration: ${result.conflicts.join(', ')}`);
      }
      return false;
    }
    spinner.stop(result.tokenRevoked ? 'Codex integration and runtime token removed' : 'Codex integration removed');
    if (result.conflicts.length > 0) {
      input.ui.info(`Preserved edited configuration blocks: ${result.conflicts.join(', ')}`);
    }
    return result.removed;
  } catch (error) {
    spinner.error('Could not remove the Codex integration');
    throw error;
  }
}

async function setupHarness(input: InteractiveCommandInput, integration: CodexIntegrationService): Promise<number> {
  const existing = await input.profiles.get(input.profileName);
  return runInteractiveInferenceSetup({
    profileName: input.profileName,
    existingOrigin: existing?.origin,
    ui: input.ui,
    showIntro: false,
    session: () => authenticatedSetupClient(input.profileName, input.profiles, input.credentials, input.fetch),
    authorize: (gateway) =>
      loginCommand(
        { gateway, command: ['login'] },
        input.profileName,
        input.profiles,
        input.credentials,
        SILENT_OUTPUT,
        input.fetch,
        input.openBrowser
      ),
    configure: async (harness, context) => {
      if (harness !== 'codex') {
        throw new CliError('UNSUPPORTED_HARNESS', `Harness ${harness} is not supported by this CLI version.`);
      }
      const result = await integration.setup({
        profileName: input.profileName,
        profile: context.profile,
        discovery: context.discovery,
        client: context.client,
      });
      return {
        progress: `Configured Codex ${result.codexVersion}`,
        summary: [
          `${result.catalog.modelCount} Gateway models are ready.`,
          `Default model: ${result.defaultModel}.`,
          ...(result.warning ? [`Warning: ${result.warning}`] : []),
          'Fully quit and reopen Codex to load the current model catalog.',
        ].join('\n'),
      };
    },
  });
}

async function logout(input: InteractiveCommandInput): Promise<number> {
  const spinner = input.ui.spinner('Removing Gateway authorization...');
  try {
    await logoutCommand(input.profileName, input.profiles, input.credentials, SILENT_OUTPUT, input.fetch);
    spinner.stop('Gateway authorization removed');
    input.ui.outro('Logged out. Harness configuration and runtime tokens were left unchanged.');
    return 0;
  } catch (error) {
    spinner.error('Could not remove Gateway authorization');
    throw error;
  }
}

function createIntegration(input: InteractiveCommandInput): CodexIntegrationService {
  return new CodexIntegrationService(input.paths, input.credentials, {
    fetch: input.fetch,
    commandRunner: input.commandRunner,
    runtimeSource: input.runtimeSource,
    env: input.env,
    home: input.home,
    proxyDaemon: input.proxyDaemon,
  });
}

const SILENT_OUTPUT: Output = { json: false, write() {} };
