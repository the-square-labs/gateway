import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError } from './errors.js';
import type { CliPaths } from './paths.js';

const ROOT_START = '# >>> wiolett-gateway:active';
const ROOT_END = '# <<< wiolett-gateway:active';
const ROOT_KEYS = new Set(['model_provider', 'model_catalog_json']);

export interface CodexIntegrationPaths {
  codexHome: string;
  configFile: string;
  profileDir: string;
  catalogFile: string;
  metadataFile: string;
  lockFile: string;
  stateFile: string;
}

interface ManagedIntegration {
  providerId: string;
  mcpId: string;
  baseUrl: string;
  catalogFile: string;
  runtimeFile: string;
  providerBlock: string;
  mcpBlock: string;
  rootBlock: string;
  updatedAt: string;
}

interface CodexManagedStateSnapshot {
  schemaVersion: 1;
  configFile: string;
  originalRootLines: string[];
  activeProfile?: string;
  activeRootBlock?: string;
  integrations: Record<string, ManagedIntegration>;
}

interface CodexManagedState extends CodexManagedStateSnapshot {
  pending?: {
    backupFile: string;
    previousState: CodexManagedStateSnapshot | null;
  };
}

export interface CodexConfigResult {
  providerId: string;
  mcpId: string;
  configFile: string;
  backupFile: string;
  changed: boolean;
}

export function resolveCodexPaths(
  paths: CliPaths,
  profile: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): CodexIntegrationPaths {
  const codexHome = env.CODEX_HOME || join(home, '.codex');
  const profileDir = join(paths.dataDir, 'profiles', safeId(profile));
  return {
    codexHome,
    configFile: join(codexHome, 'config.toml'),
    profileDir,
    catalogFile: join(profileDir, 'codex-model-catalog.json'),
    metadataFile: join(profileDir, 'codex-catalog-state.json'),
    lockFile: join(profileDir, 'codex-catalog.lock'),
    stateFile: join(paths.dataDir, 'codex-integrations.json'),
  };
}

export async function configureCodex(input: {
  paths: CodexIntegrationPaths;
  profile: string;
  baseUrl: string;
  runtimeFile: string;
  now?: () => Date;
  afterConfigWrite?: () => Promise<void> | void;
}): Promise<CodexConfigResult> {
  const providerId = `wiolett-${safeId(input.profile)}`;
  const mcpId = `wiolett-inference-${safeId(input.profile)}`;
  const rootBlock = rootBlockFor(providerId, input.paths.catalogFile);
  const providerBlock = providerBlockFor(input.profile, providerId, input.baseUrl, input.runtimeFile);
  const mcpBlock = mcpBlockFor(input.profile, mcpId, input.runtimeFile);
  const original = await readOptional(input.paths.configFile);
  const persistedState = await readState(input.paths.stateFile);
  const previousState = persistedState ? structuredClone(persistedState) : null;
  const state =
    (persistedState ? structuredClone(persistedState) : null) ??
    ({
      schemaVersion: 1,
      configFile: input.paths.configFile,
      originalRootLines: rootAssignmentLines(original),
      integrations: {},
    } satisfies CodexManagedStateSnapshot);
  if (state.configFile !== input.paths.configFile) {
    throw new CliError('CODEX_HOME_CHANGED', 'Codex home changed; remove the existing integration before setup.');
  }

  let next = stripRootAssignments(original);
  next = replaceBlock(next, ROOT_START, ROOT_END, rootBlock, true);
  next = replaceBlock(next, providerStart(input.profile), providerEnd(input.profile), providerBlock, false);
  next = replaceBlock(next, mcpStart(input.profile), mcpEnd(input.profile), mcpBlock, false);
  next = normalizeTrailingNewline(next);

  await mkdir(dirname(input.paths.configFile), { recursive: true, mode: 0o700 });
  await mkdir(input.paths.profileDir, { recursive: true, mode: 0o700 });
  const backupFile = join(
    input.paths.profileDir,
    `config.${(input.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-')}.${randomUUID()}.bak`
  );
  await writeFile(backupFile, original, { mode: 0o600, flag: 'wx' });

  state.activeProfile = input.profile;
  state.activeRootBlock = rootBlock;
  state.integrations[input.profile] = {
    providerId,
    mcpId,
    baseUrl: input.baseUrl,
    catalogFile: input.paths.catalogFile,
    runtimeFile: input.runtimeFile,
    providerBlock,
    mcpBlock,
    rootBlock,
    updatedAt: (input.now?.() ?? new Date()).toISOString(),
  };
  const finalState = structuredClone(state) satisfies CodexManagedStateSnapshot;
  const journal: CodexManagedState = {
    ...finalState,
    pending: {
      backupFile,
      previousState,
    },
  };
  await atomicJsonWrite(input.paths.stateFile, journal);
  try {
    if (next !== original) await atomicTextWrite(input.paths.configFile, next);
    await input.afterConfigWrite?.();
    await atomicJsonWrite(input.paths.stateFile, finalState);
  } catch (error) {
    await restoreCodexBackup(input.paths.configFile, backupFile);
    await restoreStateSnapshot(input.paths.stateFile, journal.pending!.previousState);
    throw error;
  }
  return { providerId, mcpId, configFile: input.paths.configFile, backupFile, changed: next !== original };
}

export async function removeCodexConfiguration(input: {
  paths: CodexIntegrationPaths;
  profile: string;
}): Promise<{ removed: boolean; conflicts: string[]; activeProfile?: string }> {
  const state = await readState(input.paths.stateFile);
  const integration = state?.integrations[input.profile];
  if (!state || !integration) return { removed: false, conflicts: [] };
  let config = await readOptional(input.paths.configFile);
  const conflicts: string[] = [];

  config = removeOwnedBlock(config, providerStart(input.profile), providerEnd(input.profile));
  config = removeOwnedBlock(config, mcpStart(input.profile), mcpEnd(input.profile));
  delete state.integrations[input.profile];

  if (state.activeProfile === input.profile) {
    const replacement = Object.entries(state.integrations).sort(([, a], [, b]) =>
      b.updatedAt.localeCompare(a.updatedAt)
    )[0];
    if (replacement) {
      config = replaceBlock(config, ROOT_START, ROOT_END, replacement[1].rootBlock, true);
      state.activeProfile = replacement[0];
      state.activeRootBlock = replacement[1].rootBlock;
    } else {
      config = replaceBlock(config, ROOT_START, ROOT_END, '', true);
      config = restoreRootAssignments(config, state.originalRootLines);
      delete state.activeProfile;
      delete state.activeRootBlock;
    }
  }

  await atomicTextWrite(input.paths.configFile, normalizeTrailingNewline(config));
  if (Object.keys(state.integrations).length === 0) await rm(input.paths.stateFile, { force: true });
  else await atomicJsonWrite(input.paths.stateFile, state);
  return { removed: true, conflicts, ...(state.activeProfile ? { activeProfile: state.activeProfile } : {}) };
}

export async function inspectCodexConfiguration(input: { paths: CodexIntegrationPaths; profile: string }) {
  const state = await readState(input.paths.stateFile);
  const integration = state?.integrations[input.profile];
  const config = await readOptional(input.paths.configFile);
  if (!state || !integration) return { configured: false, conflicts: [] as string[] };
  const conflicts: string[] = [];
  if (
    !managedBlockSatisfies(
      findBlock(config, providerStart(input.profile), providerEnd(input.profile)),
      integration.providerBlock,
      new Set(['supports_websockets', 'refresh_interval_ms', 'timeout_ms'])
    )
  ) {
    conflicts.push('model provider');
  }
  if (
    !managedBlockSatisfies(
      findBlock(config, mcpStart(input.profile), mcpEnd(input.profile)),
      integration.mcpBlock,
      new Set(['startup_timeout_sec'])
    )
  ) {
    conflicts.push('MCP server');
  }
  if (
    state.activeProfile === input.profile &&
    !managedBlockSatisfies(findBlock(config, ROOT_START, ROOT_END), integration.rootBlock)
  ) {
    conflicts.push('active Codex selection');
  }
  return {
    configured: true,
    active: state.activeProfile === input.profile,
    conflicts,
    providerId: integration.providerId,
    mcpId: integration.mcpId,
    catalogFile: integration.catalogFile,
  };
}

function rootBlockFor(providerId: string, catalogFile: string): string {
  return `${ROOT_START}\nmodel_provider = ${tomlString(providerId)}\nmodel_catalog_json = ${tomlString(catalogFile)}\n${ROOT_END}`;
}

function providerBlockFor(profile: string, providerId: string, baseUrl: string, runtimeFile: string): string {
  return `${providerStart(profile)}
[model_providers.${tomlString(providerId)}]
# Codex currently gates remote /responses/compact by the provider's canonical
# OpenAI name. Auth remains package-command-backed and provider-scoped below.
name = "OpenAI"
base_url = ${tomlString(baseUrl)}
wire_api = "responses"
requires_openai_auth = false
supports_websockets = true

[model_providers.${tomlString(providerId)}.auth]
command = ${tomlString(process.execPath)}
args = [${tomlString(runtimeFile)}, "inference", "auth", "codex", "--profile", ${tomlString(profile)}]
refresh_interval_ms = 0
timeout_ms = 5000
${providerEnd(profile)}`;
}

function mcpBlockFor(profile: string, mcpId: string, runtimeFile: string): string {
  return `${mcpStart(profile)}
[mcp_servers.${tomlString(mcpId)}]
command = ${tomlString(process.execPath)}
args = [${tomlString(runtimeFile)}, "inference", "mcp", "--profile", ${tomlString(profile)}]
startup_timeout_sec = 30
${mcpEnd(profile)}`;
}

function providerStart(profile: string) {
  return `# >>> wiolett-gateway:provider:${safeId(profile)}`;
}
function providerEnd(profile: string) {
  return `# <<< wiolett-gateway:provider:${safeId(profile)}`;
}
function mcpStart(profile: string) {
  return `# >>> wiolett-gateway:mcp:${safeId(profile)}`;
}
function mcpEnd(profile: string) {
  return `# <<< wiolett-gateway:mcp:${safeId(profile)}`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function safeId(value: string): string {
  const slug = value.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) || 'profile';
  const digest = createHash('sha256').update(value).digest('base64url').slice(0, 12);
  return `${slug}-${digest}`;
}

function findBlock(content: string, start: string, end: string): string | null {
  const startIndex = content.indexOf(start);
  if (startIndex < 0) return null;
  const endIndex = content.indexOf(end, startIndex + start.length);
  if (endIndex < 0) throw new CliError('CODEX_CONFIG_CONFLICT', `Managed Codex block is incomplete: ${start}`);
  return content.slice(startIndex, endIndex + end.length);
}

function replaceBlock(content: string, start: string, end: string, block: string, root: boolean): string {
  const current = findBlock(content, start, end);
  if (current) {
    if (block) return content.replace(current, block);
    const startIndex = content.indexOf(current);
    let endIndex = startIndex + current.length;
    const following = content.slice(endIndex).match(/^(?:\r?\n){1,2}/)?.[0];
    if (following) endIndex += following.length;
    return `${content.slice(0, startIndex)}${content.slice(endIndex)}`;
  }
  if (!block) return content;
  if (!root) return `${normalizeTrailingNewline(content)}\n${block}\n`;
  const sectionIndex = content.search(/^\s*\[/m);
  if (sectionIndex < 0) return `${normalizeTrailingNewline(content)}${block}\n`;
  const prefix = content.slice(0, sectionIndex).replace(/\s+$/, '');
  return `${prefix ? `${prefix}\n` : ''}${block}\n\n${content.slice(sectionIndex)}`;
}

function removeOwnedBlock(content: string, start: string, end: string): string {
  const current = findBlock(content, start, end);
  if (!current) return content;
  return content.replace(current, '').replace(/\n{3,}/g, '\n\n');
}

function managedBlockSatisfies(
  current: string | null,
  expected: string,
  ignoredKeys: ReadonlySet<string> = new Set()
): boolean {
  if (!current) return false;
  const currentAssignments = managedAssignments(current);
  for (const [key, value] of managedAssignments(expected)) {
    const assignmentKey = key.slice(key.lastIndexOf('\0') + 1);
    if (ignoredKeys.has(assignmentKey)) continue;
    if (currentAssignments.get(key) !== value) return false;
  }
  return true;
}

function managedAssignments(block: string): Map<string, string> {
  const assignments = new Map<string, string>();
  let section = '';
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.replace(/\s+/g, '');
      continue;
    }
    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!assignment) continue;
    assignments.set(`${section}\0${assignment[1]}`, normalizeTomlValue(assignment[2]));
  }
  return assignments;
}

function normalizeTomlValue(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value.replace(/\s+/g, ' ').trim();
  }
}

function rootAssignmentLines(content: string): string[] {
  const root = rootPortion(content);
  return root.split(/\r?\n/).filter((line) => {
    const key = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1];
    return key ? ROOT_KEYS.has(key) : false;
  });
}

function stripRootAssignments(content: string): string {
  const sectionIndex = content.search(/^\s*\[/m);
  const boundary = sectionIndex < 0 ? content.length : sectionIndex;
  const root = content
    .slice(0, boundary)
    .split(/\r?\n/)
    .filter((line) => {
      const key = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1];
      return !key || !ROOT_KEYS.has(key);
    })
    .join('\n');
  return `${root}${content.slice(boundary)}`;
}

function restoreRootAssignments(content: string, lines: string[]): string {
  if (lines.length === 0) return content;
  const sectionIndex = content.search(/^\s*\[/m);
  const boundary = sectionIndex < 0 ? content.length : sectionIndex;
  return `${content.slice(0, boundary).replace(/\s+$/, '')}\n${lines.join('\n')}\n\n${content.slice(boundary)}`;
}

function rootPortion(content: string): string {
  const sectionIndex = content.search(/^\s*\[/m);
  return content.slice(0, sectionIndex < 0 ? content.length : sectionIndex);
}

function normalizeTrailingNewline(content: string): string {
  return content.replace(/\s*$/, '\n');
}

async function readOptional(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

async function readState(file: string): Promise<CodexManagedState | null> {
  try {
    const state = JSON.parse(await readFile(file, 'utf8')) as CodexManagedState;
    if (state.schemaVersion !== 1 || !state.integrations) throw new Error('Unsupported state');
    if (state.pending) {
      await restoreCodexBackup(state.configFile, state.pending.backupFile);
      await restoreStateSnapshot(file, state.pending.previousState);
      return state.pending.previousState;
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new CliError('CODEX_STATE_INVALID', 'Codex integration state is unreadable.', { cause: error });
  }
}

async function atomicTextWrite(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, file);
}

async function atomicJsonWrite(file: string, value: unknown): Promise<void> {
  await atomicTextWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function restoreCodexBackup(configFile: string, backupFile: string): Promise<void> {
  await atomicTextWrite(configFile, await readFile(backupFile, 'utf8'));
}

async function restoreStateSnapshot(file: string, snapshot: CodexManagedStateSnapshot | null): Promise<void> {
  if (snapshot) await atomicJsonWrite(file, snapshot);
  else await rm(file, { force: true });
}
