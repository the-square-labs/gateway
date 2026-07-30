import { readVisibleCatalogModels } from './codex-catalog.js';
import { inspectCodexConfiguration, resolveCodexPaths } from './codex-config.js';
import { CodexIntegrationService, type CommandRunner } from './codex-integration.js';
import type { CredentialStore } from './credentials.js';
import { CliError } from './errors.js';
import type { Fetch } from './http.js';
import { isAuthorizationRequired, runInteractiveInferenceSetup } from './interactive-setup.js';
import type { InteractiveCliUi, InteractiveOption } from './interactive-ui.js';
import { loginCommand, logoutCommand } from './login-command.js';
import type { Output } from './output.js';
import type { CliPaths } from './paths.js';
import type { ProfileStore } from './profiles.js';
import { authenticatedSetupClient } from './session.js';
import type { SetupIdentity } from './types.js';

export interface InteractiveCommandInput {
  profileName: string;
  profileExplicit?: boolean;
  gateway?: string;
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
}

type InferenceAction = 'authenticate' | 'sync' | 'setup' | 'logout';

export async function runInteractiveRootCommand(input: InteractiveCommandInput): Promise<number> {
  input.ui.intro('Wiolett Gateway');
  const module = await input.ui.select('Choose a module', [
    {
      value: 'inference',
      label: 'Inference',
      hint: 'Authentication, model catalog, and harness integrations',
    },
  ]);
  if (!module) {
    input.ui.cancel('No module selected.');
    return 0;
  }
  return runInteractiveInferenceCommand(input, false);
}

export async function runInteractiveInferenceCommand(
  input: InteractiveCommandInput,
  showIntro = true
): Promise<number> {
  if (showIntro) input.ui.intro('Wiolett Gateway · Inference');
  if (await shouldShowProfile(input)) input.ui.info(`Profile: ${input.profileName}`);

  const integration = new CodexIntegrationService(input.paths, input.credentials, {
    fetch: input.fetch,
    commandRunner: input.commandRunner,
    runtimeSource: input.runtimeSource,
    env: input.env,
    home: input.home,
  });
  const state = await loadInferenceMenuState(input);
  if (state.identity) showAccount(input.ui, state.identity);
  if (state.models.length > 0) {
    input.ui.info(`Models: ${state.models.join(', ')}`);
  }

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
      showAccount(input.ui, state.identity);
      continue;
    }
    if (action === 'logout') return logout(input);
    if (action === 'setup') return setupHarness(input, integration);
    state.models = await syncModels(input, integration);
  }
}

export async function runInteractiveHarnessSetupCommand(input: InteractiveCommandInput): Promise<number> {
  const integration = new CodexIntegrationService(input.paths, input.credentials, {
    fetch: input.fetch,
    commandRunner: input.commandRunner,
    runtimeSource: input.runtimeSource,
    env: input.env,
    home: input.home,
  });
  input.ui.intro('Wiolett Gateway inference setup');
  if (await shouldShowProfile(input)) input.ui.info(`Profile: ${input.profileName}`);
  return setupHarness(input, integration);
}

async function shouldShowProfile(input: InteractiveCommandInput): Promise<boolean> {
  if (input.profileExplicit) return true;
  const profiles = await input.profiles.list();
  return Object.keys(profiles.profiles).length > 1;
}

async function loadInferenceMenuState(input: InteractiveCommandInput): Promise<{
  identity?: SetupIdentity;
  harnessConfigured: boolean;
  models: string[];
}> {
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

function inferenceActions(
  identity: SetupIdentity | undefined,
  harnessConfigured: boolean,
  modelCount: number
): InteractiveOption[] {
  const options: InteractiveOption[] = [];
  if (!identity) {
    options.push({
      value: 'authenticate',
      label: 'Authenticate',
      hint: 'Authorize this CLI through Gateway OAuth',
    });
  }
  options.push({
    value: 'sync',
    label: 'Re-sync models',
    hint: !identity
      ? 'Authenticate first'
      : harnessConfigured
        ? `${modelCount} models currently cached`
        : 'Set up a harness first',
    disabled: !identity || !harnessConfigured,
  });
  options.push({
    value: 'setup',
    label: 'Setup harness',
    hint: harnessConfigured ? 'Reconfigure or repair an integration' : 'Configure a supported inference harness',
  });
  if (identity) {
    options.push({
      value: 'logout',
      label: 'Logout',
      hint: `Remove authorization for ${identity.user.email}`,
    });
  }
  return options;
}

async function authenticate(input: InteractiveCommandInput): Promise<SetupIdentity | null> {
  const existing = await input.profiles.get(input.profileName);
  const gateway = input.gateway ?? existing?.origin ?? (await input.ui.gatewayOrigin());
  if (!gateway) {
    input.ui.cancel('Authentication cancelled.');
    return null;
  }
  const spinner = input.ui.spinner('Complete authorization in your browser...');
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
    spinner.stop('Gateway authorization complete');
    return identity;
  } catch (error) {
    spinner.error('Gateway authorization failed');
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

async function setupHarness(input: InteractiveCommandInput, integration: CodexIntegrationService): Promise<number> {
  const existing = await input.profiles.get(input.profileName);
  return runInteractiveInferenceSetup({
    profileName: input.profileName,
    gateway: input.gateway,
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
        summary: `${result.catalog.modelCount} Gateway models are ready.\nRestart Codex to load the current model catalog.`,
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

const SILENT_OUTPUT: Output = { json: false, write() {} };
