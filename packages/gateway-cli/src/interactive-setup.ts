import { CliError } from './errors.js';
import type { InteractiveCliUi, InteractiveOption } from './interactive-ui.js';
import type { GatewayProfile } from './profiles.js';
import type { InferenceSetupClient } from './tokens.js';
import type { InferenceDiscovery } from './types.js';

const AUTHORIZATION_REQUIRED_CODES = new Set([
  'PROFILE_NOT_FOUND',
  'NOT_LOGGED_IN',
  'AUTHORIZATION_EXPIRED',
  'AUTHORIZATION_REVOKED',
]);
const CLI_SUPPORTED_HARNESSES = new Set(['codex']);

export interface InteractiveSetupSession {
  profile: GatewayProfile;
  discovery: InferenceDiscovery;
  client: InferenceSetupClient;
}

export async function runInteractiveInferenceSetup(input: {
  profileName: string;
  gateway?: string;
  existingOrigin?: string;
  ui: InteractiveCliUi;
  showIntro?: boolean;
  session: () => Promise<InteractiveSetupSession>;
  authorize: (gateway: string) => Promise<void>;
  configure: (harness: string, session: InteractiveSetupSession) => Promise<{ progress: string; summary: string }>;
}): Promise<number> {
  if (input.showIntro !== false) {
    input.ui.intro('Wiolett Gateway inference setup');
    input.ui.info(`Profile: ${input.profileName}`);
  }
  let session: InteractiveSetupSession;

  try {
    session = await input.session();
    input.ui.info(`Connected to ${session.profile.origin}`);
  } catch (error) {
    if (!isAuthorizationRequired(error)) throw error;
    const gateway = input.gateway ?? input.existingOrigin ?? (await input.ui.gatewayOrigin());
    if (!gateway) {
      input.ui.cancel('Setup cancelled.');
      return 0;
    }
    const spinner = input.ui.spinner('Complete authorization in your browser...');
    try {
      await input.authorize(gateway);
      spinner.stop('Gateway authorization complete');
    } catch (authorizationError) {
      spinner.error('Gateway authorization failed');
      throw authorizationError;
    }
    session = await input.session();
  }

  const harnesses = supportedHarnesses(session.discovery);
  if (harnesses.length === 0) {
    throw new CliError('NO_SUPPORTED_HARNESSES', 'This Gateway does not advertise a supported inference harness.');
  }
  const harness = await input.ui.select('Which harness do you want to configure?', harnesses);
  if (!harness) {
    input.ui.cancel('Setup cancelled.');
    return 0;
  }

  const spinner = input.ui.spinner(`Configuring ${harnessLabel(harness)}...`);
  try {
    const result = await input.configure(harness, session);
    spinner.stop(result.progress);
    input.ui.outro(result.summary);
    return 0;
  } catch (error) {
    spinner.error(`Could not configure ${harnessLabel(harness)}`);
    throw error;
  }
}

export function isAuthorizationRequired(error: unknown): boolean {
  return error instanceof CliError && AUTHORIZATION_REQUIRED_CODES.has(error.code);
}

function supportedHarnesses(discovery: InferenceDiscovery): InteractiveOption[] {
  return Object.entries(discovery.harnesses)
    .filter(([harness, value]) => value.supported && CLI_SUPPORTED_HARNESSES.has(harness))
    .map(([value]) => ({ value, ...harnessPresentation(value) }));
}

function harnessPresentation(harness: string): Pick<InteractiveOption, 'label' | 'hint'> {
  if (harness === 'codex') {
    return {
      label: 'Codex CLI',
      hint: 'Gateway models, reasoning, tools, and automatic catalog refresh',
    };
  }
  return { label: harnessLabel(harness), hint: 'Advertised by this Gateway instance' };
}

function harnessLabel(harness: string): string {
  return harness === 'codex' ? 'Codex CLI' : harness;
}
