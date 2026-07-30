import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError } from './errors.js';
import type { CliPaths } from './paths.js';

const MANAGED_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
  'DISABLE_LOGIN_COMMAND',
  'DISABLE_LOGOUT_COMMAND',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const;

type Snapshot = { present: boolean; value?: unknown };

interface ClaudeCodeIntegrationState {
  version: 1;
  profile: string;
  configFile: string;
  managed: {
    apiKeyHelper: string;
    env: Record<(typeof MANAGED_ENV_KEYS)[number], string>;
  };
  previous: {
    apiKeyHelper: Snapshot;
    env: Record<(typeof MANAGED_ENV_KEYS)[number], Snapshot>;
  };
}

export interface ClaudeCodePaths {
  configDir: string;
  configFile: string;
  stateFile: string;
}

export function resolveClaudeCodePaths(
  paths: CliPaths,
  profile: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): ClaudeCodePaths {
  const configDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const configFile = join(configDir, 'settings.json');
  const identity = createHash('sha256').update(`${profile}\0${configFile}`).digest('base64url').slice(0, 24);
  return {
    configDir,
    configFile,
    stateFile: join(paths.dataDir, 'claude-code-integrations', `${identity}.json`),
  };
}

export function claudeCodeApiKeyHelper(runtimeFile: string, platform = process.platform): string {
  const args = [process.execPath, runtimeFile, '__credential', 'claude-code'];
  return platform === 'win32' ? args.map(windowsShellQuote).join(' ') : args.map(posixShellQuote).join(' ');
}

export async function configureClaudeCode(input: {
  paths: ClaudeCodePaths;
  profile: string;
  baseUrl: string;
  model: string;
  runtimeFile: string;
}): Promise<{ configFile: string; stateFile: string; apiKeyHelper: string }> {
  const settings = await readSettings(input.paths.configFile);
  const state = await readState(input.paths.stateFile);
  const apiKeyHelper = claudeCodeApiKeyHelper(input.runtimeFile);
  const managed: ClaudeCodeIntegrationState['managed'] = {
    apiKeyHelper,
    env: {
      ANTHROPIC_BASE_URL: input.baseUrl.replace(/\/+$/, ''),
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
      DISABLE_LOGIN_COMMAND: '1',
      DISABLE_LOGOUT_COMMAND: '1',
      ANTHROPIC_DEFAULT_OPUS_MODEL: input.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: input.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: input.model,
    },
  };

  if (state) assertOwnedValues(settings, state.managed);
  else assertAvailableValues(settings, managed);

  const previous = state?.previous ?? {
    apiKeyHelper: snapshot(settings, 'apiKeyHelper'),
    env: Object.fromEntries(MANAGED_ENV_KEYS.map((key) => [key, snapshot(settingsEnv(settings), key)])) as Record<
      (typeof MANAGED_ENV_KEYS)[number],
      Snapshot
    >,
  };
  const next = structuredClone(settings);
  next.apiKeyHelper = managed.apiKeyHelper;
  next.env = { ...settingsEnv(next), ...managed.env };
  const nextState: ClaudeCodeIntegrationState = {
    version: 1,
    profile: input.profile,
    configFile: input.paths.configFile,
    managed,
    previous,
  };

  const original = JSON.stringify(settings, null, 2);
  await atomicJsonWrite(input.paths.configFile, next);
  try {
    await atomicJsonWrite(input.paths.stateFile, nextState);
  } catch (error) {
    await atomicTextWrite(input.paths.configFile, `${original}\n`);
    throw error;
  }
  return { configFile: input.paths.configFile, stateFile: input.paths.stateFile, apiKeyHelper };
}

export async function inspectClaudeCodeConfiguration(input: {
  paths: ClaudeCodePaths;
}): Promise<{ configured: boolean; conflicts: string[]; model?: string }> {
  const state = await readState(input.paths.stateFile);
  if (!state) return { configured: false, conflicts: [] };
  const settings = await readSettings(input.paths.configFile);
  const conflicts = ownedValueConflicts(settings, state.managed);
  return {
    configured: true,
    conflicts,
    model: state.managed.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
  };
}

export async function removeClaudeCodeConfiguration(input: {
  paths: ClaudeCodePaths;
}): Promise<{ removed: boolean; conflicts: string[] }> {
  const state = await readState(input.paths.stateFile);
  if (!state) return { removed: true, conflicts: [] };
  const settings = await readSettings(input.paths.configFile);
  const conflicts = ownedValueConflicts(settings, state.managed);
  if (conflicts.length) return { removed: false, conflicts };

  const next = structuredClone(settings);
  restoreSnapshot(next, 'apiKeyHelper', state.previous.apiKeyHelper);
  const env = settingsEnv(next);
  for (const key of MANAGED_ENV_KEYS) restoreSnapshot(env, key, state.previous.env[key]);
  if (Object.keys(env).length) next.env = env;
  else delete next.env;
  await atomicJsonWrite(input.paths.configFile, next);
  await rm(input.paths.stateFile, { force: true });
  return { removed: true, conflicts: [] };
}

function assertAvailableValues(
  settings: Record<string, unknown>,
  managed: ClaudeCodeIntegrationState['managed']
): void {
  const conflicts: string[] = [];
  if (settings.apiKeyHelper !== undefined && settings.apiKeyHelper !== managed.apiKeyHelper) {
    conflicts.push('apiKeyHelper');
  }
  const env = settingsEnv(settings);
  for (const key of MANAGED_ENV_KEYS) {
    if (env[key] !== undefined && env[key] !== managed.env[key]) conflicts.push(`env.${key}`);
  }
  if (conflicts.length) {
    throw new CliError(
      'CLAUDE_CONFIG_CONFLICT',
      `Claude Code settings are already managed by another configuration: ${conflicts.join(', ')}`
    );
  }
}

function assertOwnedValues(settings: Record<string, unknown>, managed: ClaudeCodeIntegrationState['managed']): void {
  const conflicts = ownedValueConflicts(settings, managed);
  if (conflicts.length) {
    throw new CliError(
      'CLAUDE_CONFIG_CONFLICT',
      `Managed Claude Code settings were edited: ${conflicts.join(', ')}. Restore or remove them before setup.`
    );
  }
}

function ownedValueConflicts(
  settings: Record<string, unknown>,
  managed: ClaudeCodeIntegrationState['managed']
): string[] {
  const conflicts: string[] = [];
  if (settings.apiKeyHelper !== managed.apiKeyHelper) conflicts.push('apiKeyHelper');
  const env = settingsEnv(settings);
  for (const key of MANAGED_ENV_KEYS) {
    if (env[key] !== managed.env[key]) conflicts.push(`env.${key}`);
  }
  return conflicts;
}

function settingsEnv(settings: Record<string, unknown>): Record<string, unknown> {
  if (settings.env === undefined) return {};
  if (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env)) {
    throw new CliError('CLAUDE_CONFIG_INVALID', 'Claude Code settings env must be an object.');
  }
  return settings.env as Record<string, unknown>;
}

async function readSettings(file: string): Promise<Record<string, unknown>> {
  const value = await readJson(file, 'CLAUDE_CONFIG_INVALID', 'Claude Code settings are not valid JSON.');
  if (value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError('CLAUDE_CONFIG_INVALID', 'Claude Code settings must contain a JSON object.');
  }
  settingsEnv(value as Record<string, unknown>);
  return value as Record<string, unknown>;
}

async function readState(file: string): Promise<ClaudeCodeIntegrationState | null> {
  const value = await readJson(file, 'CLAUDE_STATE_INVALID', 'Claude Code integration state is unreadable.');
  if (value === null) return null;
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) {
    throw new CliError('CLAUDE_STATE_INVALID', 'Claude Code integration state is unreadable.');
  }
  return value as ClaudeCodeIntegrationState;
}

async function readJson(file: string, code: string, message: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new CliError(code, message, { cause: error });
  }
}

function snapshot(object: Record<string, unknown>, key: string): Snapshot {
  return Object.hasOwn(object, key) ? { present: true, value: object[key] } : { present: false };
}

function restoreSnapshot(object: Record<string, unknown>, key: string, value: Snapshot): void {
  if (value.present) object[key] = value.value;
  else delete object[key];
}

async function atomicJsonWrite(file: string, value: unknown): Promise<void> {
  await atomicTextWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicTextWrite(file: string, value: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

function posixShellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function windowsShellQuote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}
