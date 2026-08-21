import { createHash } from 'node:crypto';
import type {
  InferenceProviderDefinition,
  InferenceProviderModelPricing,
} from '../providers/inference-provider.types.js';

/**
 * Deterministic mapping between Gateway provider/connection records and core
 * resources (plan T4). Two families exist:
 *
 * - API-key/local connections map 1:1 to a core provider entry named
 *   `core-<connectionId>`; the entry holds the key, so its lifecycle follows
 *   the connection exactly.
 * - OAuth subscription connections cannot use arbitrary entry names: the core
 *   resolves OAuth tokens by provider entry name and its login flow upserts
 *   the canonical entry. They therefore map to the canonical core provider
 *   (`anthropic`, `kimi`, `xai`) or the ChatGPT account pool behind the
 *   built-in `openai` forward provider, and each Gateway connection row
 *   represents one account inside that core-side set.
 */

/** metadata.coreManaged marks rows whose credentials live in the core. */
export const CORE_MANAGED_METADATA_KEY = 'coreManaged';

/** metadata.coreAccountId stores the account id inside the core account set. */
export const CORE_ACCOUNT_METADATA_KEY = 'coreAccountId';

/** Discovered-model metadata key holding the core-only namespaced route. */
export const CORE_MODEL_METADATA_KEY = 'coreModelId';

export type CoreOAuthTarget =
  | { kind: 'codex-pool'; coreProviderName: 'openai' }
  | { kind: 'core-oauth'; oauthProvider: string; coreProviderName: string };

/** Canonical core OAuth target for a Gateway OAuth provider id, or null. */
export function coreOAuthTarget(providerId: string): CoreOAuthTarget | null {
  switch (providerId) {
    case 'openai':
      return { kind: 'codex-pool', coreProviderName: 'openai' };
    case 'anthropic':
      return { kind: 'core-oauth', oauthProvider: 'anthropic', coreProviderName: 'anthropic' };
    case 'kimi':
      return { kind: 'core-oauth', oauthProvider: 'kimi', coreProviderName: 'kimi' };
    case 'xai':
      return { kind: 'core-oauth', oauthProvider: 'xai', coreProviderName: 'xai' };
    default:
      return null;
  }
}

/** Core provider entry name for an API-key/local connection. */
export function coreKeyProviderName(connectionId: string): string {
  return `core-${connectionId}`;
}

/**
 * The core provider entry a connection's models route through. OAuth
 * connections share the canonical entry; key connections own their entry.
 */
export function coreProviderRef(connection: { id: string; providerId: string; authType: string }): string {
  if (connection.authType === 'oauth') {
    const target = coreOAuthTarget(connection.providerId);
    if (target) return target.coreProviderName;
  }
  return coreKeyProviderName(connection.id);
}

/** Gateway wire-protocol names map onto core adapter names. */
export function coreAdapterForWireProtocol(wireProtocol: string): string {
  switch (wireProtocol) {
    case 'openai-responses':
      return 'openai-responses';
    case 'anthropic-messages':
      return 'anthropic';
    case 'google-gemini':
      return 'google';
    default:
      return 'openai-chat';
  }
}

/**
 * Core provider entry payload for an API-key/local connection. Secrets cross
 * only here — management POST /api/providers over the private network — and
 * are never persisted in Gateway storage.
 */
export function buildCoreProviderConfig(args: {
  definition: InferenceProviderDefinition;
  baseUrl: string;
  authType: 'api_key' | 'local';
  apiKey?: string;
  allowPrivateNetwork?: boolean;
  disabled?: boolean;
}): Record<string, unknown> {
  const { definition, baseUrl, authType, apiKey, allowPrivateNetwork, disabled } = args;
  return {
    ...(definition.id !== 'openai-compatible' ? { templateId: definition.id } : {}),
    adapter: coreAdapterForWireProtocol(definition.wireProtocol),
    baseUrl,
    authMode: authType === 'local' ? 'local' : 'key',
    ...(apiKey ? { apiKey } : {}),
    ...(definition.staticHeaders ? { headers: definition.staticHeaders } : {}),
    ...(definition.liveModels !== undefined ? { liveModels: definition.liveModels } : {}),
    ...(allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
    ...(disabled !== undefined ? { disabled } : {}),
  };
}

/** Narrow a core /api/models row. Other fields are passed through defensively. */
export interface CoreModelRow {
  provider: string;
  id: string;
  namespaced: string;
  disabled?: boolean;
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  inputModalities?: string[];
  capabilities?: string[];
  parallelToolCalls?: boolean;
  supportsReasoningSummaries?: boolean;
  supportsServiceTier?: boolean;
  supportsVerbosity?: boolean;
  pricing?: CoreModelPricing;
}

export interface CoreModelPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  cacheWriteUsdPerMillion: number;
  source: 'opencodex-catalog';
}

function parseCoreModelPricing(value: unknown): CoreModelPricing | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const pricing = value as Record<string, unknown>;
  if (pricing.source !== 'opencodex-catalog') return undefined;
  const values = [
    pricing.inputUsdPerMillion,
    pricing.outputUsdPerMillion,
    pricing.cachedInputUsdPerMillion,
    pricing.cacheWriteUsdPerMillion,
  ];
  if (values.some((candidate) => typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0)) {
    return undefined;
  }
  return {
    inputUsdPerMillion: pricing.inputUsdPerMillion as number,
    outputUsdPerMillion: pricing.outputUsdPerMillion as number,
    cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion as number,
    cacheWriteUsdPerMillion: pricing.cacheWriteUsdPerMillion as number,
    source: 'opencodex-catalog',
  };
}

function usdPerMillionToMicrodollars(value: number): number | undefined {
  const converted = Math.round(value * 1_000_000);
  return Number.isSafeInteger(converted) && converted >= 0 ? converted : undefined;
}

/** Convert the managed-core USD rates into Gateway's exact integer accounting units. */
export function coreModelPricing(row: CoreModelRow): InferenceProviderModelPricing | undefined {
  if (!row.pricing) return undefined;
  const input = usdPerMillionToMicrodollars(row.pricing.inputUsdPerMillion);
  const output = usdPerMillionToMicrodollars(row.pricing.outputUsdPerMillion);
  const cachedInput = usdPerMillionToMicrodollars(row.pricing.cachedInputUsdPerMillion);
  const cacheWrite = usdPerMillionToMicrodollars(row.pricing.cacheWriteUsdPerMillion);
  if (input === undefined || output === undefined || cachedInput === undefined || cacheWrite === undefined) {
    return undefined;
  }
  const rates = [input, output, cachedInput, cacheWrite];
  const digest = createHash('sha256').update(rates.join(':')).digest('hex').slice(0, 24);
  return {
    version: `opencodex-catalog-v1-${digest}`,
    inputMicrodollarsPerMillion: input,
    cachedInputMicrodollarsPerMillion: cachedInput,
    cacheWriteMicrodollarsPerMillion: cacheWrite,
    outputMicrodollarsPerMillion: output,
    source: 'provider',
  };
}

/** Project OpenCodex catalog metadata onto Gateway's boolean capability map. */
export function coreModelCapabilities(row: CoreModelRow): Record<string, boolean> {
  const capabilities = Object.fromEntries((row.capabilities ?? []).map((capability) => [capability, true] as const));
  const modalities = new Set(row.inputModalities ?? []);
  return {
    ...capabilities,
    tools: capabilities.tools === true,
    reasoning: (row.reasoningEfforts?.length ?? 0) > 0,
    vision: modalities.has('image'),
    ...(row.parallelToolCalls !== undefined ? { parallelToolCalls: row.parallelToolCalls } : {}),
    ...(row.supportsReasoningSummaries !== undefined ? { reasoningSummaries: row.supportsReasoningSummaries } : {}),
    ...(row.supportsServiceTier !== undefined ? { serviceTier: row.supportsServiceTier } : {}),
    ...(row.supportsVerbosity !== undefined ? { verbosity: row.supportsVerbosity } : {}),
  };
}

export function parseCoreModelRows(body: unknown): CoreModelRow[] {
  if (!Array.isArray(body)) return [];
  const rows: CoreModelRow[] = [];
  for (const entry of body) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.provider !== 'string' || typeof row.id !== 'string') continue;
    const pricing = parseCoreModelPricing(row.pricing);
    rows.push({
      provider: row.provider,
      id: row.id,
      namespaced: typeof row.namespaced === 'string' && row.namespaced ? row.namespaced : row.id,
      ...(row.disabled === true ? { disabled: true } : {}),
      ...(typeof row.contextWindow === 'number' ? { contextWindow: row.contextWindow } : {}),
      ...(typeof row.maxInputTokens === 'number' ? { maxInputTokens: row.maxInputTokens } : {}),
      ...(typeof row.maxOutputTokens === 'number' ? { maxOutputTokens: row.maxOutputTokens } : {}),
      ...(Array.isArray(row.reasoningEfforts)
        ? { reasoningEfforts: row.reasoningEfforts.filter((effort): effort is string => typeof effort === 'string') }
        : {}),
      ...(typeof row.defaultReasoningEffort === 'string' ? { defaultReasoningEffort: row.defaultReasoningEffort } : {}),
      ...(Array.isArray(row.inputModalities)
        ? {
            inputModalities: row.inputModalities.filter((modality): modality is string => typeof modality === 'string'),
          }
        : {}),
      ...(Array.isArray(row.capabilities)
        ? {
            capabilities: row.capabilities.filter((capability): capability is string => typeof capability === 'string'),
          }
        : {}),
      ...(typeof row.parallelToolCalls === 'boolean' ? { parallelToolCalls: row.parallelToolCalls } : {}),
      ...(typeof row.supportsReasoningSummaries === 'boolean'
        ? { supportsReasoningSummaries: row.supportsReasoningSummaries }
        : {}),
      ...(typeof row.supportsServiceTier === 'boolean' ? { supportsServiceTier: row.supportsServiceTier } : {}),
      ...(typeof row.supportsVerbosity === 'boolean' ? { supportsVerbosity: row.supportsVerbosity } : {}),
      ...(pricing ? { pricing } : {}),
    });
  }
  return rows;
}

/** Narrow one core /api/provider-quotas report. */
export interface CoreQuotaReport {
  provider: string;
  quota: {
    fiveHourPercent?: number;
    fiveHourResetAt?: number;
    weeklyPercent?: number;
    weeklyResetAt?: number;
    monthlyPercent?: number;
    monthlyResetAt?: number;
    creditsUsd?: { remaining?: number; limit?: number };
  };
}

export function parseCoreQuotaReports(body: unknown): CoreQuotaReport[] {
  if (!body || typeof body !== 'object') return [];
  const reports = (body as { reports?: unknown }).reports;
  if (!Array.isArray(reports)) return [];
  const parsed: CoreQuotaReport[] = [];
  for (const entry of reports) {
    if (!entry || typeof entry !== 'object') continue;
    const report = entry as Record<string, unknown>;
    if (typeof report.provider !== 'string' || !report.quota || typeof report.quota !== 'object') continue;
    const quota = report.quota as Record<string, unknown>;
    const credits =
      quota.creditsUsd && typeof quota.creditsUsd === 'object' ? (quota.creditsUsd as Record<string, unknown>) : null;
    parsed.push({
      provider: report.provider,
      quota: {
        ...(typeof quota.fiveHourPercent === 'number' ? { fiveHourPercent: quota.fiveHourPercent } : {}),
        ...(typeof quota.fiveHourResetAt === 'number' ? { fiveHourResetAt: quota.fiveHourResetAt } : {}),
        ...(typeof quota.weeklyPercent === 'number' ? { weeklyPercent: quota.weeklyPercent } : {}),
        ...(typeof quota.weeklyResetAt === 'number' ? { weeklyResetAt: quota.weeklyResetAt } : {}),
        ...(typeof quota.monthlyPercent === 'number' ? { monthlyPercent: quota.monthlyPercent } : {}),
        ...(typeof quota.monthlyResetAt === 'number' ? { monthlyResetAt: quota.monthlyResetAt } : {}),
        ...(credits
          ? {
              creditsUsd: {
                ...(typeof credits.remaining === 'number' ? { remaining: credits.remaining } : {}),
                ...(typeof credits.limit === 'number' ? { limit: credits.limit } : {}),
              },
            }
          : {}),
      },
    });
  }
  return parsed;
}

/**
 * Project one core quota report into Gateway quota windows. Core percentages
 * are usage (0-100 used); Gateway windows store the remaining fraction.
 */
export function coreQuotaToWindows(report: CoreQuotaReport): Array<{
  dimension: string;
  remainingFraction?: number;
  remainingValue?: string;
  limitValue?: string;
  resetAt?: Date;
  metadata?: Record<string, unknown>;
}> {
  const windows: Array<{
    dimension: string;
    remainingFraction?: number;
    remainingValue?: string;
    limitValue?: string;
    resetAt?: Date;
    metadata?: Record<string, unknown>;
  }> = [];
  const resetDate = (value: number | undefined): Date | undefined => {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
    const date = new Date(value > 10_000_000_000 ? value : value * 1000);
    return Number.isFinite(date.getTime()) ? date : undefined;
  };
  const usage = (percent: number | undefined, resetAt: number | undefined, dimension: string) => {
    if (percent === undefined) return;
    const normalizedResetAt = resetDate(resetAt);
    windows.push({
      dimension,
      remainingFraction: Math.max(0, Math.min(1, 1 - percent / 100)),
      ...(normalizedResetAt ? { resetAt: normalizedResetAt } : {}),
    });
  };
  usage(report.quota.fiveHourPercent, report.quota.fiveHourResetAt, '5h');
  usage(report.quota.weeklyPercent, report.quota.weeklyResetAt, '7d');
  usage(report.quota.monthlyPercent, report.quota.monthlyResetAt, '30d');
  if (
    report.quota.creditsUsd &&
    (report.quota.creditsUsd.remaining !== undefined || report.quota.creditsUsd.limit !== undefined)
  ) {
    const remaining = report.quota.creditsUsd.remaining;
    const limit = report.quota.creditsUsd.limit;
    windows.push({
      dimension: 'subscription',
      ...(remaining !== undefined && limit !== undefined && limit >= 0
        ? { remainingFraction: limit === 0 ? 0 : Math.max(0, Math.min(1, remaining / limit)) }
        : {}),
      ...(remaining !== undefined ? { remainingValue: String(remaining) } : {}),
      ...(limit !== undefined ? { limitValue: String(limit) } : {}),
    });
  }
  return windows;
}
