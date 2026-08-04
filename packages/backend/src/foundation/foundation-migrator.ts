import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_SANDBOX_WORKSPACE_DIR = '/var/lib/gateway/sandbox-workspaces';

const SANDBOX_VOLUME_START = '# gateway-managed:start sandbox-workspace';
const SANDBOX_VOLUME_END = '# gateway-managed:end sandbox-workspace';

export interface FoundationMigrationOptions {
  hostDir: string;
  targetVersion?: string;
  imageRef?: string;
  sandboxWorkspaceDir?: string;
}

export interface FoundationMigrationResult {
  changedFiles: string[];
  backupDir: string | null;
  sandboxWorkspaceDir: string;
}

interface PendingFoundationWrite {
  relativePath: string;
  filePath: string;
  content: string;
}

interface EnvPatchResult {
  content: string;
  values: Map<string, string>;
}

export async function runFoundationMigrations(options: FoundationMigrationOptions): Promise<FoundationMigrationResult> {
  const hostDir = path.resolve(options.hostDir);
  const envPath = path.join(hostDir, '.env');
  const composePath = path.join(hostDir, 'docker-compose.yml');
  const backupDir = path.join(hostDir, '.gateway-foundation-backups', timestampForPath(new Date()));
  const defaultSandboxWorkspaceDir = options.sandboxWorkspaceDir ?? DEFAULT_SANDBOX_WORKSPACE_DIR;

  const envContent = await fs.readFile(envPath, 'utf8');
  const envPatch = patchEnv(envContent, {
    ...(options.targetVersion ? { GATEWAY_VERSION: options.targetVersion } : {}),
    ...(options.imageRef ? { GATEWAY_IMAGE_REF: options.imageRef } : {}),
    SANDBOX_RUNNER_WORKSPACE_DIR: envValue(envContent, 'SANDBOX_RUNNER_WORKSPACE_DIR') ?? defaultSandboxWorkspaceDir,
  });

  const composeContent = await fs.readFile(composePath, 'utf8');
  const composePatch = patchCompose(composeContent);

  const effectiveSandboxWorkspaceDir =
    envPatch.values.get('SANDBOX_RUNNER_WORKSPACE_DIR') ?? defaultSandboxWorkspaceDir;

  const pendingWrites: PendingFoundationWrite[] = [];
  if (envPatch.content !== envContent) {
    pendingWrites.push({ relativePath: '.env', filePath: envPath, content: envPatch.content });
  }
  if (composePatch !== composeContent) {
    pendingWrites.push({ relativePath: 'docker-compose.yml', filePath: composePath, content: composePatch });
  }

  if (pendingWrites.length > 0) {
    for (const write of pendingWrites) {
      await backupFile(write.filePath, backupDir);
    }

    try {
      for (const write of pendingWrites) {
        await writeFileAtomic(write.filePath, write.content);
      }
    } catch (error) {
      await restoreBackups(backupDir, pendingWrites).catch((rollbackError) => {
        throw new Error(
          `foundation migration failed and rollback failed: ${formatError(error)}; rollback: ${formatError(rollbackError)}`
        );
      });
      throw error;
    }
  }

  if (path.isAbsolute(effectiveSandboxWorkspaceDir)) {
    await fs.mkdir(effectiveSandboxWorkspaceDir, { recursive: true, mode: 0o700 }).catch(() => {});
    await fs.chmod(effectiveSandboxWorkspaceDir, 0o700).catch(() => {});
  }

  return {
    changedFiles: pendingWrites.map((write) => write.relativePath),
    backupDir: pendingWrites.length > 0 ? backupDir : null,
    sandboxWorkspaceDir: effectiveSandboxWorkspaceDir,
  };
}

export function patchEnv(content: string, values: Record<string, string>): EnvPatchResult {
  const hadTrailingNewline = content.endsWith('\n');
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();

  const remaining = new Set(Object.keys(values));
  const seen = new Set<string>();
  const nextLines: string[] = [];
  const nextValues = parseEnvValues(content);

  for (const line of lines) {
    const key = envLineKey(line);
    if (!key || !(key in values)) {
      nextLines.push(line);
      continue;
    }
    if (seen.has(key)) continue;
    nextLines.push(`${key}=${values[key]}`);
    nextValues.set(key, values[key]);
    seen.add(key);
    remaining.delete(key);
  }

  if (remaining.size > 0 && nextLines.length > 0 && nextLines.at(-1) !== '') {
    nextLines.push('');
  }
  for (const key of remaining) {
    nextLines.push(`${key}=${values[key]}`);
    nextValues.set(key, values[key]);
  }

  return {
    content: `${nextLines.join('\n')}${hadTrailingNewline || nextLines.length > 0 ? '\n' : ''}`,
    values: nextValues,
  };
}

export function patchCompose(content: string): string {
  let lines = content.replace(/\r\n/g, '\n').split('\n');
  const hadTrailingNewline = lines.at(-1) === '';
  if (hadTrailingNewline) lines = lines.slice(0, -1);

  const appBlock = findServiceBlock(lines, 'app');
  if (!appBlock) throw new Error('foundation migration failed: services.app block not found in docker-compose.yml');

  const imagePatched = patchAppImage(lines, appBlock);
  const volumesPatched = patchAppSandboxVolume(imagePatched, findServiceBlock(imagePatched, 'app') ?? appBlock);
  const runtimePatched = patchAppRuntimeStorageAndSocket(volumesPatched);
  const healthcheckPatched = patchAppHealthcheck(runtimePatched);
  const environmentPatched = removeLegacyAppEnvironment(healthcheckPatched);
  const clickHousePatched = removeLegacyClickHouseService(environmentPatched);
  return `${clickHousePatched.join('\n')}${hadTrailingNewline ? '\n' : ''}`;
}

function patchAppRuntimeStorageAndSocket(lines: string[]): string[] {
  const app = findServiceBlock(lines, 'app');
  if (!app) return lines;
  const volumes = findNestedBlock(lines, app, 'volumes');
  if (!volumes) return lines;

  let next = lines.map((line, index) => {
    if (index <= volumes.start || index >= volumes.end) return line;
    return line.replace(/^(\s*-\s*\/var\/run\/docker\.sock:\/var\/run\/docker\.sock):ro(?:\s*)$/, '$1');
  });

  const refreshedApp = findServiceBlock(next, 'app');
  const refreshedVolumes = refreshedApp ? findNestedBlock(next, refreshedApp, 'volumes') : null;
  if (!refreshedVolumes) return next;

  const hasRuntimeStorage = next
    .slice(refreshedVolumes.start + 1, refreshedVolumes.end)
    .some((line) => /^\s*-\s*[^#]+:\/var\/lib\/gateway(?::(?:ro|rw))?\s*$/.test(line));
  if (hasRuntimeStorage) return next;

  const indent = ' '.repeat(refreshedVolumes.indent + 2);
  const socketLine = findDockerSocketVolume(next, refreshedVolumes.start + 1, refreshedVolumes.end);
  const insertAt = socketLine >= 0 ? socketLine + 1 : refreshedVolumes.end;
  next = [...next.slice(0, insertAt), `${indent}- gateway_data:/var/lib/gateway`, ...next.slice(insertAt)];
  return ensureTopLevelVolume(next, 'gateway_data');
}

function patchAppHealthcheck(lines: string[]): string[] {
  const app = findServiceBlock(lines, 'app');
  if (!app) return lines;
  const healthcheck = findNestedBlock(lines, app, 'healthcheck');
  if (!healthcheck) return lines;

  const next = [...lines];
  for (let index = healthcheck.start + 1; index < healthcheck.end; index += 1) {
    if (!/^\s*test\s*:/.test(next[index]) || !next[index].includes('/health')) continue;
    const indent = next[index].match(/^\s*/)?.[0] ?? '';
    next[index] =
      `${indent}test: ["CMD-SHELL", ` +
      `"wget --no-check-certificate -qO- https://127.0.0.1:3000/health || wget -qO- http://127.0.0.1:3000/health"]`;
    break;
  }
  return next;
}

function removeLegacyAppEnvironment(lines: string[]): string[] {
  const app = findServiceBlock(lines, 'app');
  if (!app) return lines;
  const environment = findNestedBlock(lines, app, 'environment');
  if (!environment) return lines;
  return lines.filter((line, index) => {
    if (index <= environment.start || index >= environment.end) return true;
    return !/^\s*(?:-\s*)?(?:OIDC_|CLICKHOUSE_|APP_URL\s*[:=]|SETUP_TOKEN\s*[:=])/.test(line);
  });
}

function removeLegacyClickHouseService(lines: string[]): string[] {
  const service = findServiceBlock(lines, 'clickhouse');
  let next = service ? [...lines.slice(0, service.start), ...lines.slice(service.end)] : lines;
  const app = findServiceBlock(next, 'app');
  const dependsOn = app ? findNestedBlock(next, app, 'depends_on') : null;
  const dependency = dependsOn ? findDirectNestedBlock(next, dependsOn, 'clickhouse') : null;
  if (dependency) next = [...next.slice(0, dependency.start), ...next.slice(dependency.end)];

  const volumes = findTopLevelBlock(next, 'volumes');
  if (volumes) {
    const clickHouseVolume = findDirectNestedBlock(next, volumes, 'clickhouse_data');
    if (clickHouseVolume) next = [...next.slice(0, clickHouseVolume.start), ...next.slice(clickHouseVolume.end)];
  }
  return next;
}

function patchAppImage(lines: string[], appBlock: { start: number; end: number; indent: number }): string[] {
  const next = [...lines];
  for (let index = appBlock.start + 1; index < appBlock.end; index += 1) {
    const match = /^(\s*)image\s*:/.exec(next[index]);
    if (!match) continue;
    next[index] = `${match[1]}image: \${GATEWAY_IMAGE_REF}`;
    return next;
  }

  // Pre-v2.5 installer-managed foundations built the application locally and
  // therefore have no app.image field. Replace that build block rather than
  // retaining it: a production update must run the verified, pinned image.
  const legacyBuild = findNestedBlock(next, appBlock, 'build');
  if (!legacyBuild) throw new Error('foundation migration failed: services.app.image or build block not found');

  const withoutBuild = [...next.slice(0, legacyBuild.start), ...next.slice(legacyBuild.end)];
  const refreshedApp = findServiceBlock(withoutBuild, 'app');
  if (!refreshedApp) throw new Error('foundation migration failed: services.app block not found');
  const indent = ' '.repeat(refreshedApp.indent + 2);
  return [
    ...withoutBuild.slice(0, refreshedApp.start + 1),
    `${indent}image: \${GATEWAY_IMAGE_REF}`,
    ...withoutBuild.slice(refreshedApp.start + 1),
  ];
}

function patchAppSandboxVolume(lines: string[], appBlock: { start: number; end: number; indent: number }): string[] {
  const volumes = findNestedBlock(lines, appBlock, 'volumes');
  if (!volumes)
    throw new Error('foundation migration failed: services.app.volumes block not found in docker-compose.yml');

  const volumeIndent = `${' '.repeat(volumes.indent + 2)}`;
  const canonicalBlock = [
    `${volumeIndent}${SANDBOX_VOLUME_START}`,
    `${volumeIndent}- \${SANDBOX_RUNNER_WORKSPACE_DIR:-${DEFAULT_SANDBOX_WORKSPACE_DIR}}:\${SANDBOX_RUNNER_WORKSPACE_DIR:-${DEFAULT_SANDBOX_WORKSPACE_DIR}}`,
    `${volumeIndent}${SANDBOX_VOLUME_END}`,
  ];

  const markerStart = findLineInRange(lines, volumes.start + 1, volumes.end, SANDBOX_VOLUME_START);
  const markerEnd = findLineInRange(lines, volumes.start + 1, volumes.end, SANDBOX_VOLUME_END);
  if (markerStart >= 0 || markerEnd >= 0) {
    if (markerStart < 0 || markerEnd < markerStart) {
      throw new Error('foundation migration failed: malformed sandbox workspace managed block');
    }
    return [...lines.slice(0, markerStart), ...canonicalBlock, ...lines.slice(markerEnd + 1)];
  }

  const existingVolume = findExistingSandboxVolume(lines, volumes.start + 1, volumes.end);
  if (existingVolume >= 0) {
    return [...lines.slice(0, existingVolume), ...canonicalBlock, ...lines.slice(existingVolume + 1)];
  }

  const dockerSocketLine = findDockerSocketVolume(lines, volumes.start + 1, volumes.end);
  const insertAt = dockerSocketLine >= 0 ? dockerSocketLine + 1 : volumes.end;
  return [...lines.slice(0, insertAt), ...canonicalBlock, ...lines.slice(insertAt)];
}

function findServiceBlock(lines: string[], serviceName: string): { start: number; end: number; indent: number } | null {
  const servicesBlock = findTopLevelBlock(lines, 'services');
  if (!servicesBlock) return null;
  return findDirectNestedBlock(lines, servicesBlock, serviceName);
}

function findTopLevelBlock(lines: string[], key: string): { start: number; end: number; indent: number } | null {
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(?:#.*)?$`);
  for (let index = 0; index < lines.length; index += 1) {
    if (!pattern.test(lines[index])) continue;
    return { start: index, end: findBlockEnd(lines, index + 1, 0), indent: 0 };
  }
  return null;
}

function findDirectNestedBlock(
  lines: string[],
  parent: { start: number; end: number; indent: number },
  key: string
): { start: number; end: number; indent: number } | null {
  const directIndent = firstChildIndent(lines, parent);
  if (directIndent === null) return null;
  const nestedPattern = new RegExp(`^(\\s{${directIndent}})${escapeRegExp(key)}\\s*:\\s*(?:#.*)?$`);
  for (let index = parent.start + 1; index < parent.end; index += 1) {
    const match = nestedPattern.exec(lines[index]);
    if (!match) continue;
    return {
      start: index,
      end: Math.min(findBlockEnd(lines, index + 1, directIndent), parent.end),
      indent: directIndent,
    };
  }
  return null;
}

function firstChildIndent(lines: string[], parent: { start: number; end: number; indent: number }): number | null {
  for (let index = parent.start + 1; index < parent.end; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent > parent.indent) return indent;
  }
  return null;
}

function findNestedBlock(
  lines: string[],
  parent: { start: number; end: number; indent: number },
  key: string
): { start: number; end: number; indent: number } | null {
  const nestedPattern = new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*:\\s*(?:#.*)?$`);
  for (let index = parent.start + 1; index < parent.end; index += 1) {
    const match = nestedPattern.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length;
    if (indent <= parent.indent) continue;
    return { start: index, end: Math.min(findBlockEnd(lines, index + 1, indent), parent.end), indent };
  }
  return null;
}

function findBlockEnd(lines: string[], start: number, indent: number): number {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const currentIndent = line.length - line.trimStart().length;
    if (currentIndent <= indent) return index;
  }
  return lines.length;
}

function findLineInRange(lines: string[], start: number, end: number, text: string): number {
  for (let index = start; index < end; index += 1) {
    if (lines[index].includes(text)) return index;
  }
  return -1;
}

function findExistingSandboxVolume(lines: string[], start: number, end: number): number {
  for (let index = start; index < end; index += 1) {
    const line = lines[index];
    if (
      line.includes('SANDBOX_RUNNER_WORKSPACE_DIR') ||
      line.includes(`${DEFAULT_SANDBOX_WORKSPACE_DIR}:${DEFAULT_SANDBOX_WORKSPACE_DIR}`)
    ) {
      return index;
    }
  }
  return -1;
}

function findDockerSocketVolume(lines: string[], start: number, end: number): number {
  for (let index = start; index < end; index += 1) {
    if (/^\s*-\s+\/var\/run\/docker\.sock:/.test(lines[index])) return index;
  }
  return -1;
}

function ensureTopLevelVolume(lines: string[], volumeName: string): string[] {
  const volumes = findTopLevelBlock(lines, 'volumes');
  if (!volumes) {
    const separator = lines.length > 0 && lines.at(-1)?.trim() ? [''] : [];
    return [...lines, ...separator, 'volumes:', `  ${volumeName}:`];
  }

  const pattern = new RegExp(`^\\s+${escapeRegExp(volumeName)}\\s*:`);
  if (lines.slice(volumes.start + 1, volumes.end).some((line) => pattern.test(line))) return lines;
  return [...lines.slice(0, volumes.end), `  ${volumeName}:`, ...lines.slice(volumes.end)];
}

function envValue(content: string, key: string): string | null {
  return parseEnvValues(content).get(key) ?? null;
}

function parseEnvValues(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
    const key = envLineKey(line);
    if (!key || values.has(key)) continue;
    values.set(key, line.slice(key.length + 1));
  }
  return values;
}

function envLineKey(line: string): string | null {
  const match = /^([A-Z_][A-Z0-9_]*)=/.exec(line);
  return match?.[1] ?? null;
}

async function backupFile(filePath: string, backupDir: string): Promise<void> {
  await fs.mkdir(backupDir, { recursive: true });
  await fs.copyFile(filePath, path.join(backupDir, path.basename(filePath)));
}

async function restoreBackups(backupDir: string, writes: PendingFoundationWrite[]): Promise<void> {
  for (const write of writes) {
    const backupPath = path.join(backupDir, path.basename(write.filePath));
    const backupStat = await fs.stat(backupPath);
    await fs.copyFile(backupPath, write.filePath);
    await fs.chmod(write.filePath, backupStat.mode & 0o777);
  }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const stat = await fs.stat(filePath).catch(() => null);
  await fs.writeFile(tempPath, content, { mode: stat ? stat.mode & 0o777 : 0o600 });
  await fs.rename(tempPath, filePath);
}

function timestampForPath(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
