import { and, asc, desc, eq, inArray, isNull, lte, ne } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  inferenceDiscoveredModels,
  inferenceModelSources,
  inferenceModels,
  inferencePricingSnapshots,
  inferenceProviderConnections,
  inferenceProviderCredentials,
  inferenceProviderSettings,
  inferenceQuotaSnapshots,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { providerApiMonthlySpend } from '../accounting/inference-provider-budget.js';
import { InferenceCoreClientError } from '../core/inference-core.client.js';
import type { InferenceCoreBridgeService } from '../core/inference-core-bridge.service.js';
import {
  buildCoreProviderConfig,
  CORE_ACCOUNT_METADATA_KEY,
  CORE_MANAGED_METADATA_KEY,
  CORE_MODEL_METADATA_KEY,
  coreKeyProviderName,
  coreModelCapabilities,
  coreModelPricing,
  coreOAuthTarget,
  coreProviderRef,
  coreQuotaToWindows,
  parseCoreModelRows,
  parseCoreQuotaReports,
} from '../core/inference-core-provider-map.js';
import type { InferenceDestinationPolicy } from './inference-destination-policy.js';
import type { InferenceProviderRegistry } from './inference-provider.registry.js';
import {
  assertApiMonthlyLimitAllowed,
  assertMinimumRemainingAllowed,
  classifyStatus,
  connectionDisableBlockers,
  latestQuota,
  nextRoutingOrder,
  redactedError,
  serializeConnection,
  serializeModel,
  serializeQuota,
  validateBaseUrl,
} from './inference-provider.service.helpers.js';
import type {
  DiscoveredInferenceModel,
  InferenceProviderDefinition,
  InferenceQuotaWindow,
} from './inference-provider.types.js';

const SYNC_FRESH_MS = 5 * 60_000;
const LAST_GOOD_MS = 30 * 60_000;
const SYNC_RUNNING_RECOVERY_MS = 2 * SYNC_FRESH_MS;

@injectable()
export class InferenceProviderService {
  private timer: NodeJS.Timeout | null = null;
  private activeSync: Promise<void> | null = null;

  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly registry: InferenceProviderRegistry,
    private readonly audit: AuditService,
    private readonly destinations: InferenceDestinationPolicy,
    private readonly coreBridge?: InferenceCoreBridgeService
  ) {}

  /** Management delegates to the core as soon as it is installed and ready. */
  private async coreReady(): Promise<boolean> {
    return this.coreBridge ? this.coreBridge.coreReady() : false;
  }

  listCatalog() {
    return this.registry.listConnectable().map(({ oauth, ...provider }) => ({
      ...provider,
      oauthFlow: oauth?.flow ?? null,
      completionMode: oauth ? (oauth.flow === 'redirect' ? 'paste_callback' : 'device_poll') : null,
    }));
  }

  async listConnections() {
    const connections = await this.db
      .select()
      .from(inferenceProviderConnections)
      .where(isNull(inferenceProviderConnections.deletedAt))
      .orderBy(
        asc(inferenceProviderConnections.routingOrder),
        asc(inferenceProviderConnections.providerId),
        asc(inferenceProviderConnections.createdAt)
      );
    if (connections.length === 0) return [];
    const ids = connections.map((connection) => connection.id);
    const [credentials, models, quotas, settings, apiSpend] = await Promise.all([
      this.db
        .select({
          connectionId: inferenceProviderCredentials.connectionId,
          kind: inferenceProviderCredentials.credentialKind,
          last4: inferenceProviderCredentials.secretLast4,
          expiresAt: inferenceProviderCredentials.expiresAt,
        })
        .from(inferenceProviderCredentials)
        .where(inArray(inferenceProviderCredentials.connectionId, ids)),
      this.db
        .select()
        .from(inferenceDiscoveredModels)
        .where(
          and(inArray(inferenceDiscoveredModels.connectionId, ids), eq(inferenceDiscoveredModels.available, true))
        ),
      this.db
        .select()
        .from(inferenceQuotaSnapshots)
        .where(inArray(inferenceQuotaSnapshots.connectionId, ids))
        .orderBy(desc(inferenceQuotaSnapshots.fetchedAt)),
      this.db.select().from(inferenceProviderSettings),
      providerApiMonthlySpend(this.db, ids),
    ]);

    return connections.map((connection) => ({
      ...serializeConnection(connection),
      credential:
        credentials.find((credential) => credential.connectionId === connection.id) ??
        // Core-managed rows never hold a Gateway credential; surface a presence
        // indicator so the UI does not render them as missing-key legacy rows.
        (connection.metadata[CORE_MANAGED_METADATA_KEY] === true
          ? {
              connectionId: connection.id,
              kind: connection.authType,
              last4: null,
              expiresAt: null,
            }
          : null),
      routingStrategy:
        settings.find((setting) => setting.providerId === connection.providerId)?.routingStrategy ?? 'balanced',
      discoveredModels: models
        .filter((model) => model.connectionId === connection.id)
        .map((model) => serializeModel(model, connection.providerId)),
      quota: latestQuota(quotas.filter((quota) => quota.connectionId === connection.id)).map(serializeQuota),
      apiMonthlySpentMicrodollars: apiSpend.get(connection.id) ?? 0,
    }));
  }

  async createKeyConnection(
    userId: string,
    input: {
      providerId: string;
      name: string;
      apiKey?: string;
      baseUrl?: string;
      authType?: 'api_key' | 'local';
      allowPrivateNetwork?: boolean;
    }
  ) {
    let provider: InferenceProviderDefinition;
    try {
      provider = this.registry.requireConnectable(input.providerId);
    } catch {
      throw new AppError(400, 'INFERENCE_PROVIDER_NOT_CONNECTABLE', 'Provider is not available for new connections');
    }
    const authType = input.authType ?? 'api_key';
    if (!provider.authTypes.includes(authType)) {
      throw new AppError(
        400,
        'INFERENCE_PROVIDER_AUTH_UNSUPPORTED',
        'Provider does not support this authentication type'
      );
    }
    if (authType === 'api_key' && !input.apiKey?.trim()) {
      throw new AppError(400, 'INFERENCE_PROVIDER_KEY_REQUIRED', 'API key is required');
    }
    const requestedBaseUrl = input.baseUrl?.trim();
    if (requestedBaseUrl && requestedBaseUrl !== provider.baseUrl && !provider.allowBaseUrlOverride) {
      throw new AppError(400, 'INFERENCE_PROVIDER_BASE_URL_FIXED', 'This provider uses a fixed upstream base URL');
    }
    const baseUrl = validateBaseUrl(
      requestedBaseUrl || provider.baseUrl,
      provider.allowBaseUrlOverride === true || input.providerId === 'openai-compatible'
    );
    await this.destinations.assertAllowed(baseUrl, input.allowPrivateNetwork === true);
    if (!(await this.coreReady())) {
      throw new AppError(409, 'INFERENCE_CORE_NOT_READY', 'Install the inference core before connecting providers');
    }
    return this.createCoreKeyConnection(userId, provider, input, authType, baseUrl);
  }

  async getConnection(connectionId: string) {
    const rows = await this.listConnections();
    const connection = rows.find((row) => row.id === connectionId);
    if (!connection) throw new AppError(404, 'INFERENCE_PROVIDER_NOT_FOUND', 'Provider connection not found');
    return connection;
  }

  async syncConnection(connectionId: string, force = false) {
    const connection = await this.requireConnection(connectionId);
    if (!force && connection.lastSyncedAt && connection.lastSyncedAt.getTime() + SYNC_FRESH_MS > Date.now()) {
      return this.getConnection(connectionId);
    }
    if (connection.metadata[CORE_MANAGED_METADATA_KEY] === true) {
      return this.syncCoreConnection(connectionId);
    }
    // Legacy rows survive only as historical metadata after the engine
    // removal: there is no wire connector to sync them with anymore.
    await this.db
      .update(inferenceProviderConnections)
      .set({
        status: connection.lastSyncedAt ? 'stale' : 'unavailable',
        healthReason: 'Reconnect this provider through the inference core',
        syncStatus: 'error',
        syncLastError: 'Reconnect this provider through the inference core',
        nextSyncAt: new Date(Date.now() + SYNC_FRESH_MS),
        updatedAt: new Date(),
      })
      .where(eq(inferenceProviderConnections.id, connectionId));
    return this.getConnection(connectionId);
  }

  async updateConnection(
    userId: string,
    connectionId: string,
    input: {
      enabled?: boolean;
      name?: string;
      routingOrder?: number;
      minimumRemainingPercent?: number;
      apiMonthlyLimitMicrodollars?: number | null;
    }
  ) {
    const connection = await this.requireConnection(connectionId);
    const provider = this.registry.require(connection.providerId);
    if (input.enabled === false && connection.enabled) await this.assertConnectionCanDisable(connectionId);
    if (input.minimumRemainingPercent !== undefined) {
      assertMinimumRemainingAllowed(provider, input.minimumRemainingPercent);
    }
    assertApiMonthlyLimitAllowed(provider, input.apiMonthlyLimitMicrodollars);
    if (
      connection.metadata[CORE_MANAGED_METADATA_KEY] === true &&
      input.enabled !== undefined &&
      input.enabled !== connection.enabled
    ) {
      await this.mirrorCoreConnectionEnabled(connection, input.enabled);
    }
    await this.db
      .update(inferenceProviderConnections)
      .set({
        ...(input.enabled !== undefined && input.enabled !== connection.enabled
          ? { enabled: input.enabled, status: input.enabled ? 'pending' : 'disabled' }
          : {}),
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.routingOrder !== undefined ? { routingOrder: input.routingOrder } : {}),
        ...(input.minimumRemainingPercent !== undefined
          ? { minimumRemainingPercent: input.minimumRemainingPercent }
          : {}),
        ...(input.apiMonthlyLimitMicrodollars !== undefined
          ? { apiMonthlyLimitMicrodollars: input.apiMonthlyLimitMicrodollars }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(inferenceProviderConnections.id, connectionId));
    await this.audit.log({
      userId,
      action: 'inference.provider.update',
      resourceType: 'inference_provider_connection',
      resourceId: connectionId,
      details: { fields: Object.keys(input) },
    });
    return this.getConnection(connectionId);
  }

  async setRoutingStrategy(userId: string, providerId: string, routingStrategy: 'even' | 'balanced' | 'sequential') {
    this.registry.require(providerId);
    await this.db
      .insert(inferenceProviderSettings)
      .values({ providerId, routingStrategy })
      .onConflictDoUpdate({
        target: inferenceProviderSettings.providerId,
        set: { routingStrategy, updatedAt: new Date() },
      });
    await this.audit.log({
      userId,
      action: 'inference.provider.routing.update',
      resourceType: 'inference_provider',
      resourceId: providerId,
      details: { routingStrategy },
    });
    return { providerId, routingStrategy };
  }

  async disconnect(userId: string, connectionId: string): Promise<void> {
    const connection = await this.requireConnection(connectionId);
    await this.assertConnectionCanDisable(connectionId);
    if (connection.metadata[CORE_MANAGED_METADATA_KEY] === true) {
      await this.removeCoreConnectionArtifacts(connection);
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(inferenceProviderCredentials).where(eq(inferenceProviderCredentials.connectionId, connectionId));
      await tx
        .update(inferenceProviderConnections)
        .set({ enabled: false, status: 'disabled', deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(inferenceProviderConnections.id, connectionId));
    });
    await this.audit.log({
      userId,
      action: 'inference.provider.disconnect',
      resourceType: 'inference_provider_connection',
      resourceId: connectionId,
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.runDueSync(), 60_000);
    this.timer.unref();
    this.runDueSync();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.activeSync;
  }

  async syncDue(now = new Date()): Promise<void> {
    const due = await this.db
      .select({
        id: inferenceProviderConnections.id,
        syncStatus: inferenceProviderConnections.syncStatus,
        updatedAt: inferenceProviderConnections.updatedAt,
      })
      .from(inferenceProviderConnections)
      .where(
        and(
          eq(inferenceProviderConnections.enabled, true),
          isNull(inferenceProviderConnections.deletedAt),
          lte(inferenceProviderConnections.nextSyncAt, now)
        )
      );
    await Promise.allSettled(
      due
        .filter(
          (connection) =>
            connection.syncStatus !== 'running' ||
            connection.updatedAt.getTime() <= now.getTime() - SYNC_RUNNING_RECOVERY_MS
        )
        .map((connection) => this.syncConnection(connection.id, true))
    );
  }

  private runDueSync(): void {
    if (this.activeSync) return;
    const active = this.syncDue()
      .catch(() => undefined)
      .finally(() => {
        if (this.activeSync === active) this.activeSync = null;
      });
    this.activeSync = active;
  }

  // ----------------------------------------------------- core-managed paths
  // Core-managed variants: credentials and routing live in the managed core,
  // Gateway rows stay the browser-facing record (plan T4). No dual writes:
  // these paths replace the legacy credential store instead of mirroring it.

  private async createCoreKeyConnection(
    userId: string,
    provider: InferenceProviderDefinition,
    input: { name: string; apiKey?: string; allowPrivateNetwork?: boolean },
    authType: 'api_key' | 'local',
    baseUrl: string
  ) {
    const client = await this.coreBridge!.requireClient();
    const [lastConnection] = await this.db
      .select({ routingOrder: inferenceProviderConnections.routingOrder })
      .from(inferenceProviderConnections)
      .where(isNull(inferenceProviderConnections.deletedAt))
      .orderBy(desc(inferenceProviderConnections.routingOrder))
      .limit(1);
    const [connection] = await this.db
      .insert(inferenceProviderConnections)
      .values({
        providerId: provider.id,
        name: input.name.trim(),
        authType,
        baseUrl,
        routingOrder: nextRoutingOrder(lastConnection?.routingOrder),
        metadata: {
          allowPrivateNetwork: input.allowPrivateNetwork === true,
          [CORE_MANAGED_METADATA_KEY]: true,
        },
        createdBy: userId,
      })
      .returning();
    try {
      await client.createCoreProvider(
        coreKeyProviderName(connection.id),
        buildCoreProviderConfig({
          definition: provider,
          baseUrl,
          authType,
          ...(input.apiKey ? { apiKey: input.apiKey.trim() } : {}),
          allowPrivateNetwork: input.allowPrivateNetwork === true,
        })
      );
    } catch (error) {
      // The row never went live; remove it so a rejected connect leaves no orphan.
      await this.db.delete(inferenceProviderConnections).where(eq(inferenceProviderConnections.id, connection.id));
      throw asCoreManagementError(error, 'Core rejected the provider configuration');
    }
    await this.audit.log({
      userId,
      action: 'inference.provider.connect',
      resourceType: 'inference_provider_connection',
      resourceId: connection.id,
      details: { providerId: provider.id, authType, coreManaged: true },
    });
    return this.syncConnection(connection.id, true);
  }

  private async syncCoreConnection(connectionId: string) {
    await this.db
      .update(inferenceProviderConnections)
      .set({ syncStatus: 'running', syncLastError: null, updatedAt: new Date() })
      .where(eq(inferenceProviderConnections.id, connectionId));
    try {
      const connection = await this.requireConnection(connectionId);
      const client = await this.coreBridge!.requireClient();
      const providerRef = coreProviderRef(connection);
      const definition = this.registry.require(connection.providerId);
      if (definition.liveModels !== undefined && connection.authType !== 'oauth') {
        await client.patchCoreProvider(providerRef, { liveModels: definition.liveModels });
      }
      const [providers, modelsBody, liveModelIds, quotasBody] = await Promise.all([
        client.listCoreProviders(),
        client.listCoreModels(),
        client.coreProviderLiveModelIds(providerRef),
        client.coreProviderQuotas(),
      ]);
      const coreProvider = providers?.find((candidate) => candidate.name === providerRef);
      if (!coreProvider) {
        throw new AppError(
          502,
          'INFERENCE_CORE_PROVIDER_MISSING',
          'The inference core lost this provider configuration'
        );
      }
      const models = parseCoreModelRows(modelsBody).filter(
        (row) =>
          row.provider === providerRef &&
          row.disabled !== true &&
          (liveModelIds === null || liveModelIds.includes(row.id))
      );
      await this.persistModels(
        connectionId,
        models.map((row) => {
          const modalities = row.inputModalities ?? ['text'];
          const pricing = coreModelPricing(row);
          return {
            // Gateway owns the provider/account selection. Keep the upstream
            // model id account-agnostic so identical models from multiple
            // connections pool together and no core provider name leaks into
            // the admin UI or public model ids.
            id: row.id,
            ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
            ...(row.maxInputTokens !== undefined ? { maxInputTokens: row.maxInputTokens } : {}),
            ...(row.maxOutputTokens !== undefined ? { maxOutputTokens: row.maxOutputTokens } : {}),
            modalities,
            capabilities: coreModelCapabilities(row),
            reasoningEfforts: row.reasoningEfforts ?? [],
            ...(pricing ? { pricing } : {}),
            metadata: {
              source: 'opencodex',
              [CORE_MODEL_METADATA_KEY]: row.namespaced,
              input_modalities: modalities,
              capabilities: row.capabilities ?? [],
              ...(pricing ? { gatewayPricing: pricing } : {}),
              ...(row.defaultReasoningEffort ? { default_reasoning_effort: row.defaultReasoningEffort } : {}),
              ...(row.supportsReasoningSummaries !== undefined
                ? { supports_reasoning_summaries: row.supportsReasoningSummaries }
                : {}),
            },
          };
        })
      );
      const sourceType = definition.subscription ? 'subscription' : 'api';
      await this.db
        .update(inferenceModelSources)
        .set({ sourceType, updatedAt: new Date() })
        .where(eq(inferenceModelSources.connectionId, connectionId));
      const windows = await this.coreConnectionQuotaWindows(client, connection, parseCoreQuotaReports(quotasBody));
      await this.persistQuota(connectionId, windows);
      await this.db
        .update(inferenceProviderConnections)
        .set({
          status: classifyStatus(windows),
          healthReason: null,
          syncStatus: 'success',
          syncLastError: null,
          lastSyncedAt: new Date(),
          nextSyncAt: new Date(Date.now() + SYNC_FRESH_MS),
          updatedAt: new Date(),
        })
        .where(eq(inferenceProviderConnections.id, connectionId));
    } catch (error) {
      const connection = await this.requireConnection(connectionId);
      await this.db
        .update(inferenceProviderConnections)
        .set({
          status: connection.lastSyncedAt ? 'stale' : 'unavailable',
          healthReason: redactedError(error),
          syncStatus: 'error',
          syncLastError: redactedError(error),
          nextSyncAt: new Date(Date.now() + SYNC_FRESH_MS),
          updatedAt: new Date(),
        })
        .where(eq(inferenceProviderConnections.id, connectionId));
    }
    return this.getConnection(connectionId);
  }

  /**
   * Quota for one core-managed connection. ChatGPT pool accounts have
   * per-account quota readings; everything else uses the core's aggregate
   * report for the provider entry the connection routes through.
   */
  private async coreConnectionQuotaWindows(
    client: import('../core/inference-core.client.js').InferenceCoreClient,
    connection: typeof inferenceProviderConnections.$inferSelect,
    reports: ReturnType<typeof parseCoreQuotaReports>
  ): Promise<ReturnType<typeof coreQuotaToWindows>> {
    const providerRef = coreProviderRef(connection);
    if (connection.providerId === 'openai' && connection.authType === 'oauth') {
      const accountId = connection.metadata[CORE_ACCOUNT_METADATA_KEY];
      if (typeof accountId === 'string' && accountId) {
        const quotas = await client.coreCodexQuota();
        const raw = quotas?.[accountId];
        if (raw && typeof raw === 'object') {
          const quota = raw as Record<string, unknown>;
          return coreQuotaToWindows({
            provider: providerRef,
            quota: {
              ...(typeof quota.shortPercent === 'number' ? { fiveHourPercent: quota.shortPercent } : {}),
              ...(typeof quota.shortResetAt === 'number' ? { fiveHourResetAt: quota.shortResetAt } : {}),
              ...(typeof quota.weeklyPercent === 'number' ? { weeklyPercent: quota.weeklyPercent } : {}),
              ...(typeof quota.weeklyResetAt === 'number' ? { weeklyResetAt: quota.weeklyResetAt } : {}),
              ...(typeof quota.monthlyPercent === 'number' ? { monthlyPercent: quota.monthlyPercent } : {}),
              ...(typeof quota.monthlyResetAt === 'number' ? { monthlyResetAt: quota.monthlyResetAt } : {}),
            },
          });
        }
      }
    }
    const report = reports.find((candidate) => candidate.provider === providerRef);
    return report ? coreQuotaToWindows(report) : [];
  }

  private async mirrorCoreConnectionEnabled(
    connection: typeof inferenceProviderConnections.$inferSelect,
    enabled: boolean
  ) {
    const client = await this.coreBridge!.requireClient();
    if (connection.authType === 'oauth') {
      // OAuth accounts share the canonical core provider entry; per-account
      // pausing exists only for the ChatGPT pool. Other providers keep core
      // state untouched — the Gateway data plane never routes disabled
      // connections, and account selection stays core-internal.
      if (connection.providerId === 'openai') {
        const accountId = connection.metadata[CORE_ACCOUNT_METADATA_KEY];
        if (typeof accountId === 'string' && accountId) {
          await client.setCoreCodexAccountPaused(accountId, !enabled).catch((error) => {
            throw asCoreManagementError(error, 'Core rejected the account pause update');
          });
        }
      }
      return;
    }
    await client.patchCoreProvider(coreKeyProviderName(connection.id), { disabled: !enabled }).catch((error) => {
      throw asCoreManagementError(error, 'Core rejected the provider update');
    });
  }

  private async removeCoreConnectionArtifacts(connection: typeof inferenceProviderConnections.$inferSelect) {
    let client: import('../core/inference-core.client.js').InferenceCoreClient;
    try {
      client = await this.coreBridge!.requireClient();
    } catch (error) {
      // An unreachable core must not trap administrator cleanup; the leftover
      // entry is inert without Gateway traffic and repair owns orphans.
      if (error instanceof AppError) return;
      throw error;
    }
    try {
      if (connection.authType === 'oauth') {
        const target = coreOAuthTarget(connection.providerId);
        const accountId = connection.metadata[CORE_ACCOUNT_METADATA_KEY];
        if (target && typeof accountId === 'string' && accountId) {
          if (target.kind === 'codex-pool') await client.deleteCoreCodexAccount(accountId);
          else await client.deleteCoreOauthAccount(target.oauthProvider, accountId);
        }
        return;
      }
      await client.deleteCoreProvider(coreKeyProviderName(connection.id));
    } catch (error) {
      throw asCoreManagementError(error, 'Core rejected the disconnect');
    }
  }

  private async persistModels(connectionId: string, models: DiscoveredInferenceModel[]) {
    await this.db.transaction(async (tx) => {
      await tx
        .update(inferenceDiscoveredModels)
        .set({ available: false, updatedAt: new Date() })
        .where(eq(inferenceDiscoveredModels.connectionId, connectionId));
      for (const model of models) {
        const [persisted] = await tx
          .insert(inferenceDiscoveredModels)
          .values({
            connectionId,
            remoteModelId: model.id,
            displayName: model.displayName,
            contextWindow: model.contextWindow,
            maxInputTokens: model.maxInputTokens,
            maxOutputTokens: model.maxOutputTokens,
            autoCompactTokenLimit: model.autoCompactTokenLimit,
            modalities: model.modalities,
            capabilities: model.capabilities,
            reasoningEfforts: model.reasoningEfforts,
            metadata: model.metadata,
          })
          .onConflictDoUpdate({
            target: [inferenceDiscoveredModels.connectionId, inferenceDiscoveredModels.remoteModelId],
            set: {
              displayName: model.displayName,
              contextWindow: model.contextWindow,
              maxInputTokens: model.maxInputTokens,
              maxOutputTokens: model.maxOutputTokens,
              autoCompactTokenLimit: model.autoCompactTokenLimit,
              modalities: model.modalities,
              capabilities: model.capabilities,
              reasoningEfforts: model.reasoningEfforts,
              metadata: model.metadata,
              available: true,
              lastSeenAt: new Date(),
              updatedAt: new Date(),
            },
          })
          .returning({ id: inferenceDiscoveredModels.id });
        if (!persisted) continue;
        const coreModelId = model.metadata[CORE_MODEL_METADATA_KEY];
        if (typeof coreModelId === 'string' && coreModelId && coreModelId !== model.id) {
          await tx
            .update(inferenceModelSources)
            .set({
              discoveredModelId: persisted.id,
              upstreamModelId: model.id,
              coreModelId,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(inferenceModelSources.connectionId, connectionId),
                eq(inferenceModelSources.upstreamModelId, coreModelId)
              )
            );
        }
        if (!model.pricing) continue;
        const sources = await tx
          .select({ id: inferenceModelSources.id })
          .from(inferenceModelSources)
          .where(eq(inferenceModelSources.discoveredModelId, persisted.id));
        if (!sources.length) continue;
        await tx
          .insert(inferencePricingSnapshots)
          .values(
            sources.map(({ id }) => ({
              sourceId: id,
              version: model.pricing!.version,
              inputMicrodollarsPerMillion: model.pricing!.inputMicrodollarsPerMillion,
              cachedInputMicrodollarsPerMillion: model.pricing!.cachedInputMicrodollarsPerMillion,
              cacheWriteMicrodollarsPerMillion: model.pricing!.cacheWriteMicrodollarsPerMillion,
              outputMicrodollarsPerMillion: model.pricing!.outputMicrodollarsPerMillion,
              reasoningMicrodollarsPerMillion: model.pricing!.reasoningMicrodollarsPerMillion,
              otherUnitPrices: model.pricing!.otherUnitPrices ?? {},
              source: 'provider' as const,
            }))
          )
          .onConflictDoNothing();
      }
    });
  }

  private async persistQuota(connectionId: string, windows: InferenceQuotaWindow[]) {
    const fetchedAt = new Date();
    const validUntil = new Date(fetchedAt.getTime() + LAST_GOOD_MS);
    if (windows.length === 0) return;
    await this.db.insert(inferenceQuotaSnapshots).values(
      windows.map((window) => ({
        connectionId,
        dimension: window.dimension,
        modelBucket: window.modelBucket,
        status: 'fresh' as const,
        remainingFraction: window.remainingFraction === undefined ? null : String(window.remainingFraction),
        remainingValue: window.remainingValue,
        limitValue: window.limitValue,
        resetAt: window.resetAt,
        fetchedAt,
        validUntil,
        metadata: window.metadata ?? {},
      }))
    );
  }

  private async requireConnection(connectionId: string) {
    const connection = await this.db.query.inferenceProviderConnections.findFirst({
      where: and(eq(inferenceProviderConnections.id, connectionId), isNull(inferenceProviderConnections.deletedAt)),
    });
    if (!connection) throw new AppError(404, 'INFERENCE_PROVIDER_NOT_FOUND', 'Provider connection not found');
    return connection;
  }

  private async assertConnectionCanDisable(connectionId: string): Promise<void> {
    const affected = await this.db
      .select({ id: inferenceModels.id, displayName: inferenceModels.displayName })
      .from(inferenceModelSources)
      .innerJoin(inferenceModels, eq(inferenceModelSources.modelId, inferenceModels.id))
      .where(
        and(
          eq(inferenceModelSources.connectionId, connectionId),
          eq(inferenceModelSources.enabled, true),
          eq(inferenceModels.enabled, true)
        )
      );
    if (!affected.length) return;
    const remaining = await this.db
      .select({ modelId: inferenceModelSources.modelId })
      .from(inferenceModelSources)
      .innerJoin(inferenceProviderConnections, eq(inferenceModelSources.connectionId, inferenceProviderConnections.id))
      .where(
        and(
          inArray(
            inferenceModelSources.modelId,
            affected.map((model) => model.id)
          ),
          ne(inferenceModelSources.connectionId, connectionId),
          eq(inferenceModelSources.enabled, true),
          eq(inferenceProviderConnections.enabled, true),
          isNull(inferenceProviderConnections.deletedAt)
        )
      );
    const blocked = connectionDisableBlockers(
      affected,
      remaining.map((source) => source.modelId)
    );
    if (blocked.length) {
      throw new AppError(
        409,
        'INFERENCE_PROVIDER_IN_USE',
        `Disable or rebind published models before disconnecting this provider: ${blocked
          .map((model) => model.displayName)
          .join(', ')}`
      );
    }
  }
}

export { __testOnly } from './inference-provider.service.helpers.js';

/** Core management rejections surface their message; transport failures stay generic. */
function asCoreManagementError(error: unknown, fallback: string): Error {
  if (error instanceof AppError) return error;
  if (error instanceof InferenceCoreClientError) {
    const status = error.status && error.status >= 400 && error.status < 500 ? error.status : 502;
    return new AppError(status, 'INFERENCE_CORE_MANAGEMENT_FAILED', error.message.slice(0, 500));
  }
  return new AppError(502, 'INFERENCE_CORE_MANAGEMENT_FAILED', fallback);
}
