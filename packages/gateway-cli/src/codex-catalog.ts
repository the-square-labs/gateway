import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CliError } from './errors.js';
import { withFileLock as withSharedFileLock } from './file-lock.js';
import type { Fetch } from './http.js';

export interface CodexCatalogMetadata {
  etag?: string;
  catalogVersion?: string;
  lastSyncedAt: string;
}

export interface CatalogSyncResult {
  status: 'updated' | 'unchanged' | 'stale';
  catalogVersion?: string;
  modelCount: number;
  warning?: string;
}

interface CodexCatalog {
  models: Array<Record<string, unknown>>;
}

export async function syncCodexCatalog(input: {
  catalogUrl: string;
  token: string;
  codexVersion: string;
  catalogFile: string;
  metadataFile: string;
  lockFile: string;
  fetch?: Fetch;
  now?: () => Date;
}): Promise<CatalogSyncResult> {
  return withFileLock(input.lockFile, async () => {
    const existing = await readCatalog(input.catalogFile);
    const metadata = await readMetadata(input.metadataFile);
    const url = new URL(input.catalogUrl);
    url.searchParams.set('client_version', input.codexVersion);
    const headers = new Headers({ Accept: 'application/json', Authorization: `Bearer ${input.token}` });
    if (metadata?.etag) headers.set('If-None-Match', metadata.etag);

    let response: Response;
    try {
      response = await (input.fetch ?? globalThis.fetch)(url, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (existing) {
        return {
          status: 'stale',
          catalogVersion: metadata?.catalogVersion,
          modelCount: visibleModelCount(existing),
          warning: 'Gateway is unavailable; retained the last-good Codex catalog.',
        };
      }
      throw new CliError('CATALOG_NETWORK_ERROR', 'Could not download the Codex model catalog.', { cause: error });
    }

    if (response.status === 304) {
      if (!existing) throw new CliError('CATALOG_MISSING', 'Gateway returned 304 but no local catalog exists.');
      return {
        status: 'unchanged',
        catalogVersion: metadata?.catalogVersion,
        modelCount: visibleModelCount(existing),
      };
    }
    if (response.status === 401) {
      throw new CliError(
        'RUNTIME_TOKEN_REVOKED',
        'The Codex runtime token is invalid or revoked. Run setup codex to issue a new token.',
        { exitCode: 2 }
      );
    }
    if (!response.ok) {
      if (existing && response.status >= 500) {
        return {
          status: 'stale',
          catalogVersion: metadata?.catalogVersion,
          modelCount: visibleModelCount(existing),
          warning: `Gateway returned HTTP ${response.status}; retained the last-good Codex catalog.`,
        };
      }
      throw new CliError('CATALOG_REQUEST_FAILED', `Gateway catalog request failed with HTTP ${response.status}.`);
    }

    let catalog: unknown;
    try {
      catalog = await response.json();
    } catch (error) {
      throw new CliError('CATALOG_INVALID', 'Gateway returned invalid Codex catalog JSON.', { cause: error });
    }
    assertCodexCatalog(catalog);
    const catalogVersion = stripEtag(response.headers.get('etag'));
    const now = (input.now?.() ?? new Date()).toISOString();
    await atomicJsonWrite(input.catalogFile, catalog, 0o600);
    await atomicJsonWrite(
      input.metadataFile,
      {
        ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
        ...(catalogVersion ? { catalogVersion } : {}),
        lastSyncedAt: now,
      } satisfies CodexCatalogMetadata,
      0o600
    );
    return { status: 'updated', catalogVersion, modelCount: visibleModelCount(catalog) };
  });
}

export function assertCodexCatalog(value: unknown): asserts value is CodexCatalog {
  if (!value || typeof value !== 'object' || !Array.isArray((value as CodexCatalog).models)) {
    throw new CliError('CATALOG_INVALID', 'Codex catalog must contain a models array.');
  }
  const models = (value as CodexCatalog).models;
  if (models.length === 0) throw new CliError('CATALOG_EMPTY', 'Gateway has no models available to this user.');
  for (const model of models) {
    if (!model || typeof model !== 'object') throw new CliError('CATALOG_INVALID', 'Codex catalog model is invalid.');
    for (const key of [
      'slug',
      'display_name',
      'description',
      'visibility',
      'supported_in_api',
      'base_instructions',
      'context_window',
      'auto_compact_token_limit',
      'input_modalities',
      'supported_reasoning_levels',
    ]) {
      if (!(key in model)) throw new CliError('CATALOG_INVALID', `Codex catalog model is missing ${key}.`);
    }
    if (typeof model.slug !== 'string' || !model.slug.trim()) {
      throw new CliError('CATALOG_INVALID', 'Codex catalog model slug is invalid.');
    }
    if (
      'web_search_tool_type' in model &&
      model.web_search_tool_type !== 'text' &&
      model.web_search_tool_type !== 'text_and_image'
    ) {
      throw new CliError('CATALOG_INVALID', 'Codex catalog model web_search_tool_type is invalid.');
    }
    for (const key of ['supports_search_tool', 'use_responses_lite']) {
      if (key in model && typeof model[key] !== 'boolean') {
        throw new CliError('CATALOG_INVALID', `Codex catalog model ${key} is invalid.`);
      }
    }
  }
  if (visibleModelCount(value as CodexCatalog) === 0) {
    throw new CliError('CATALOG_EMPTY', 'Gateway catalog has no visible API models.');
  }
}

export async function readCatalog(file: string): Promise<CodexCatalog | null> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as unknown;
    assertCodexCatalog(value);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof CliError) throw error;
    throw new CliError('CATALOG_INVALID', `Local Codex catalog is unreadable: ${file}`, { cause: error });
  }
}

export async function readVisibleCatalogModels(file: string): Promise<string[]> {
  const catalog = await readCatalog(file);
  if (!catalog) return [];
  return catalog.models
    .filter((model) => model.visibility === 'list' && model.supported_in_api === true)
    .map((model) => String(model.slug))
    .sort((left, right) => left.localeCompare(right));
}

export async function readCatalogMetadata(file: string): Promise<CodexCatalogMetadata | null> {
  return readMetadata(file);
}

async function readMetadata(file: string): Promise<CodexCatalogMetadata | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as CodexCatalogMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

function visibleModelCount(catalog: CodexCatalog): number {
  return catalog.models.filter((model) => model.visibility === 'list' && model.supported_in_api === true).length;
}

function stripEtag(etag: string | null): string | undefined {
  return etag?.replace(/^W\//, '').replace(/^"|"$/g, '') || undefined;
}

async function atomicJsonWrite(file: string, value: unknown, mode: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await chmod(temporary, mode);
  await rename(temporary, file);
  await chmod(file, mode);
}

export async function withFileLock<T>(lockFile: string, operation: () => Promise<T>): Promise<T> {
  return withSharedFileLock(lockFile, operation, 'CATALOG_LOCKED');
}
