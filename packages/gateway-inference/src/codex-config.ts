import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError } from './errors.js';
import type { CliPaths } from './paths.js';

const ROOT_KEYS = new Set(['model', 'model_provider', 'model_catalog_json', 'openai_base_url']);
const ROOT_COMMENT =
  '# Gateway Inference keeps Codex on its built-in provider and authenticates through a local proxy.';

export interface CodexIntegrationPaths {
  codexHome: string;
  configFile: string;
  profileDir: string;
  catalogFile: string;
  metadataFile: string;
  lockFile: string;
  stateDir: string;
  stateFile: string;
}

interface ManagedIntegration {
  providerId: 'openai';
  mcpId: string;
  baseUrl: string;
  proxyBaseUrl: string;
  catalogFile: string;
  runtimeFile: string;
  mcpBlock: string;
  rootBlock: string;
  updatedAt: string;
}

interface CodexManagedStateSnapshot {
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
  providerId: 'openai';
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
  const configFile = join(codexHome, 'config.toml');
  const profileDir = join(paths.dataDir, 'profiles', safeId(profile));
  const stateDir = join(paths.dataDir, 'codex-integrations');
  return {
    codexHome,
    configFile,
    profileDir,
    catalogFile: join(profileDir, 'codex-model-catalog.json'),
    metadataFile: join(profileDir, 'codex-catalog-state.json'),
    lockFile: join(profileDir, 'codex-catalog.lock'),
    stateDir,
    stateFile: join(stateDir, `${safeId(configFile)}.json`),
  };
}

export async function configureCodex(input: {
  paths: CodexIntegrationPaths;
  profile: string;
  model: string;
  baseUrl: string;
  proxyBaseUrl: string;
  runtimeFile: string;
  cliHome?: string;
  now?: () => Date;
  afterConfigWrite?: () => Promise<void> | void;
}): Promise<CodexConfigResult> {
  const providerId = 'openai' as const;
  const mcpId = `wiolett-inference-${safeId(input.profile)}`;
  const rootBlock = rootBlockFor(input.model, input.paths.catalogFile, input.proxyBaseUrl);
  const mcpBlock = mcpBlockFor(mcpId, input.runtimeFile, input.cliHome);
  const original = await readOptional(input.paths.configFile);
  const unmanagedOriginal = stripManagedMarkerLines(original);
  const persistedState = await readState(input.paths.stateFile);
  const previousState = persistedState ? snapshotOf(persistedState) : null;
  const state: CodexManagedStateSnapshot = persistedState
    ? snapshotOf(persistedState)
    : {
        configFile: input.paths.configFile,
        originalRootLines: rootAssignmentLines(unmanagedOriginal),
        integrations: {},
      };
  if (state.configFile !== input.paths.configFile) {
    throw new CliError('CODEX_HOME_CHANGED', 'Codex home changed; remove the existing integration before setup.');
  }

  const now = (input.now?.() ?? new Date()).toISOString();
  state.activeProfile = input.profile;
  state.integrations[input.profile] = {
    providerId,
    mcpId,
    baseUrl: input.baseUrl,
    proxyBaseUrl: input.proxyBaseUrl,
    catalogFile: input.paths.catalogFile,
    runtimeFile: input.runtimeFile,
    mcpBlock,
    rootBlock,
    updatedAt: now,
  };
  state.activeRootBlock = rootBlock;

  const next = renderConfig(unmanagedOriginal, state);
  await mkdir(dirname(input.paths.configFile), { recursive: true, mode: 0o700 });
  await mkdir(input.paths.profileDir, { recursive: true, mode: 0o700 });
  const backupFile = join(input.paths.profileDir, `config.${now.replace(/[:.]/g, '-')}.${randomUUID()}.bak`);
  await writeFile(backupFile, original, { mode: 0o600, flag: 'wx' });

  const journal: CodexManagedState = {
    ...state,
    pending: { backupFile, previousState },
  };
  await atomicJsonWrite(input.paths.stateFile, journal);
  try {
    if (next !== original) await atomicTextWrite(input.paths.configFile, next);
    await input.afterConfigWrite?.();
    await atomicJsonWrite(input.paths.stateFile, state);
  } catch (error) {
    await restoreCodexBackup(input.paths.configFile, backupFile);
    await restoreStateSnapshot(input.paths.stateFile, previousState);
    throw error;
  }
  return { providerId, mcpId, configFile: input.paths.configFile, backupFile, changed: next !== original };
}

export async function removeCodexConfiguration(input: {
  paths: CodexIntegrationPaths;
  profile: string;
  afterConfigWrite?: () => Promise<void> | void;
}): Promise<{ removed: boolean; conflicts: string[]; activeProfile?: string }> {
  const state = await readState(input.paths.stateFile);
  if (!state?.integrations[input.profile]) return { removed: false, conflicts: [] };

  const current = await readOptional(input.paths.configFile);
  const previousState = snapshotOf(state);
  const unmanaged = stripMcpSections(
    stripManagedMarkerLines(current),
    Object.values(state.integrations).map((integration) => integration.mcpId)
  );
  delete state.integrations[input.profile];
  if (state.activeProfile === input.profile) {
    const replacement = Object.entries(state.integrations).sort(([, a], [, b]) =>
      b.updatedAt.localeCompare(a.updatedAt)
    )[0];
    if (replacement) {
      state.activeProfile = replacement[0];
      state.activeRootBlock = replacement[1].rootBlock;
    } else {
      delete state.activeProfile;
      delete state.activeRootBlock;
    }
  }

  const now = new Date().toISOString();
  await mkdir(input.paths.profileDir, { recursive: true, mode: 0o700 });
  const backupFile = join(input.paths.profileDir, `config.${now.replace(/[:.]/g, '-')}.${randomUUID()}.bak`);
  await writeFile(backupFile, current, { mode: 0o600, flag: 'wx' });
  await atomicJsonWrite(input.paths.stateFile, {
    ...previousState,
    pending: { backupFile, previousState },
  } satisfies CodexManagedState);
  try {
    await atomicTextWrite(input.paths.configFile, renderConfig(unmanaged, state));
    await input.afterConfigWrite?.();
    if (Object.keys(state.integrations).length === 0) await rm(input.paths.stateFile, { force: true });
    else await atomicJsonWrite(input.paths.stateFile, snapshotOf(state));
  } catch (error) {
    await restoreCodexBackup(input.paths.configFile, backupFile);
    await restoreStateSnapshot(input.paths.stateFile, previousState);
    throw error;
  }
  return {
    removed: true,
    conflicts: [],
    ...(state.activeProfile ? { activeProfile: state.activeProfile } : {}),
  };
}

export async function inspectCodexConfiguration(input: { paths: CodexIntegrationPaths; profile: string }) {
  const state = await readState(input.paths.stateFile);
  const integration = state?.integrations[input.profile];
  if (!state || !integration) return { configured: false, conflicts: [] as string[] };
  const config = await readOptional(input.paths.configFile);
  const conflicts: string[] = [];
  if (
    !managedBlockSatisfies(
      findMcpSection(config, integration.mcpId),
      integration.mcpBlock,
      new Set(['startup_timeout_sec'])
    )
  ) {
    conflicts.push('MCP server');
  }
  if (
    state.activeProfile === input.profile &&
    !managedBlockSatisfies(rootPortion(stripManagedMarkerLines(config)), integration.rootBlock, new Set(['model']))
  ) {
    conflicts.push('active Codex selection');
  }
  return {
    configured: true,
    active: state.activeProfile === input.profile,
    conflicts,
    providerId: integration.providerId,
    mcpId: integration.mcpId,
    baseUrl: integration.baseUrl,
    proxyBaseUrl: integration.proxyBaseUrl,
    catalogFile: integration.catalogFile,
    configFile: input.paths.configFile,
  };
}

export async function hasOtherManagedCodexHome(input: {
  paths: CodexIntegrationPaths;
  profile: string;
}): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(input.paths.stateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const stateFile = join(input.paths.stateDir, entry);
    if (stateFile === input.paths.stateFile) continue;
    const state = await readState(stateFile);
    if (state?.integrations[input.profile]) return true;
  }
  return false;
}

function rootBlockFor(model: string, catalogFile: string, proxyBaseUrl: string): string {
  return `${ROOT_COMMENT}\nmodel = ${tomlString(model)}\nmodel_provider = "openai"\nmodel_catalog_json = ${tomlString(catalogFile)}\nopenai_base_url = ${tomlString(proxyBaseUrl)}`;
}

function mcpBlockFor(mcpId: string, runtimeFile: string, cliHome?: string): string {
  const args = [runtimeFile, ...(cliHome ? ['--home', cliHome] : []), '__mcp'];
  return `[mcp_servers.${tomlString(mcpId)}]
command = ${tomlString(process.execPath)}
args = [${args.map(tomlString).join(', ')}]
startup_timeout_sec = 30`;
}

function renderConfig(unmanagedContent: string, state: CodexManagedStateSnapshot): string {
  let content = stripManagedMarkerLines(unmanagedContent);
  content = stripMcpSections(
    content,
    Object.values(state.integrations).map((integration) => integration.mcpId)
  );
  content = stripRootAssignments(content);
  if (state.activeProfile && state.activeRootBlock) {
    content = insertBlock(content, state.activeRootBlock, true);
  } else {
    content = restoreRootAssignments(content, state.originalRootLines);
  }
  for (const [, integration] of Object.entries(state.integrations).sort(([a], [b]) => a.localeCompare(b))) {
    content = insertBlock(content, integration.mcpBlock, false);
  }
  return normalizeTrailingNewline(content);
}

function stripManagedMarkerLines(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => !/^\s*#\s*(?:>>>|<<<)\s+wiolett-gateway:/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function insertBlock(content: string, block: string, root: boolean): string {
  if (!root) return `${normalizeTrailingNewline(content)}\n${block}\n`;
  const sectionIndex = content.search(/^[\t ]*\[/m);
  if (sectionIndex < 0) return `${normalizeTrailingNewline(content)}${block}\n`;
  const prefix = content.slice(0, sectionIndex).replace(/\s+$/, '');
  return `${prefix ? `${prefix}\n` : ''}${block}\n\n${content.slice(sectionIndex)}`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function safeId(value: string): string {
  const slug = value.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) || 'profile';
  const digest = createHash('sha256').update(value).digest('base64url').slice(0, 12);
  return `${slug}-${digest}`;
}

function findMcpSection(content: string, mcpId: string): string | null {
  const header = `[mcp_servers.${tomlString(mcpId)}]`;
  const match = new RegExp(`^[\\t ]*${escapeRegExp(header)}[\\t ]*$`, 'm').exec(content);
  if (!match) return null;
  const following = content.slice(match.index + match[0].length);
  const nextSection = /^[\t ]*\[/m.exec(following);
  const end = nextSection ? match.index + match[0].length + nextSection.index : content.length;
  return content.slice(match.index, end).trimEnd();
}

function stripMcpSections(content: string, mcpIds: string[]): string {
  let result = content;
  for (const mcpId of new Set(mcpIds)) {
    const section = findMcpSection(result, mcpId);
    if (section) result = result.replace(section, '');
  }
  return result.replace(/\n{3,}/g, '\n\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    const key = rootAssignmentKey(line);
    return key ? ROOT_KEYS.has(key) : false;
  });
}

function stripRootAssignments(content: string): string {
  const sectionIndex = content.search(/^[\t ]*\[/m);
  const boundary = sectionIndex < 0 ? content.length : sectionIndex;
  const root = content
    .slice(0, boundary)
    .split(/\r?\n/)
    .filter((line) => {
      if (line.trim() === ROOT_COMMENT) return false;
      const key = rootAssignmentKey(line);
      return !key || !ROOT_KEYS.has(key);
    })
    .join('\n');
  return `${root.trim() ? root : ''}${content.slice(boundary)}`;
}

function rootAssignmentKey(line: string): string | undefined {
  return line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1];
}

function restoreRootAssignments(content: string, lines: string[]): string {
  if (lines.length === 0) return content;
  const sectionIndex = content.search(/^[\t ]*\[/m);
  const boundary = sectionIndex < 0 ? content.length : sectionIndex;
  return `${content.slice(0, boundary).replace(/\s+$/, '')}\n${lines.join('\n')}\n\n${content.slice(boundary)}`;
}

function rootPortion(content: string): string {
  const sectionIndex = content.search(/^[\t ]*\[/m);
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
    if (
      !state ||
      typeof state !== 'object' ||
      typeof state.configFile !== 'string' ||
      !Array.isArray(state.originalRootLines) ||
      !state.integrations ||
      typeof state.integrations !== 'object'
    ) {
      throw new Error('Invalid state');
    }
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

function snapshotOf(state: CodexManagedState): CodexManagedStateSnapshot {
  return {
    configFile: state.configFile,
    originalRootLines: [...state.originalRootLines],
    integrations: structuredClone(state.integrations),
    ...(state.activeProfile ? { activeProfile: state.activeProfile } : {}),
    ...(state.activeRootBlock ? { activeRootBlock: state.activeRootBlock } : {}),
  };
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
