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
import type { InferenceDestinationPolicy } from './inference-destination-policy.js';
import type { InferenceProviderRegistry } from './inference-provider.registry.js';
import {
  assertApiMonthlyLimitAllowed,
  assertMinimumRemainingAllowed,
  classifyStatus,
  connectionDisableBlockers,
  isReauthError,
  latestQuota,
  nextRoutingOrder,
  preferSyncError,
  redactedError,
  serializeConnection,
  serializeModel,
  serializeQuota,
  validateBaseUrl,
} from './inference-provider.service.helpers.js';
import type { InferenceProviderDefinition, InferenceQuotaWindow } from './inference-provider.types.js';
import type { InferenceProviderCredentialService } from './inference-provider-credential.service.js';
import type { InferenceProviderHttpConnector } from './inference-provider-http.connector.js';

const SYNC_FRESH_MS = 5 * 60_000;
const LAST_GOOD_MS = 30 * 60_000;
const SYNC_RUNNING_RECOVERY_MS = 2 * SYNC_FRESH_MS;

@injectable()
export class InferenceProviderService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly registry: InferenceProviderRegistry,
    private readonly credentials: InferenceProviderCredentialService,
    private readonly connector: InferenceProviderHttpConnector,
    private readonly audit: AuditService,
    private readonly destinations: InferenceDestinationPolicy
  ) {}

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
      credential: credentials.find((credential) => credential.connectionId === connection.id) ?? null,
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
        metadata: { allowPrivateNetwork: input.allowPrivateNetwork === true },
        createdBy: userId,
      })
      .returning();
    await this.credentials.replace(connection.id, authType, input.apiKey ? { apiKey: input.apiKey.trim() } : {});
    await this.audit.log({
      userId,
      action: 'inference.provider.connect',
      resourceType: 'inference_provider_connection',
      resourceId: connection.id,
      details: { providerId: provider.id, authType },
    });
    await this.syncConnection(connection.id, true);
    return this.getConnection(connection.id);
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
    await this.db
      .update(inferenceProviderConnections)
      .set({ syncStatus: 'running', syncLastError: null, updatedAt: new Date() })
      .where(eq(inferenceProviderConnections.id, connectionId));

    try {
      const definition = this.registry.require(connection.providerId);
      await this.destinations.assertAllowed(connection.baseUrl, connection.metadata.allowPrivateNetwork === true);
      const credential = await this.credentials.get(connectionId);
      const [modelsResult, quotaResult] = await Promise.allSettled([
        this.connector.discoverModels(
          definition,
          credential,
          connection.baseUrl,
          undefined,
          connection.metadata.allowPrivateNetwork === true
        ),
        this.connector.fetchQuota(definition, credential),
      ]);
      if (modelsResult.status === 'fulfilled') await this.persistModels(connectionId, modelsResult.value);
      if (quotaResult.status === 'fulfilled') await this.persistQuota(connectionId, quotaResult.value);
      if (modelsResult.status === 'rejected' && quotaResult.status === 'rejected') {
        throw preferSyncError(modelsResult.reason, quotaResult.reason);
      }
      const quotas = quotaResult.status === 'fulfilled' ? quotaResult.value : [];
      const status = classifyStatus(quotas);
      const warnings = [modelsResult, quotaResult]
        .filter((result) => result.status === 'rejected')
        .map((result) => redactedError((result as PromiseRejectedResult).reason));
      await this.db
        .update(inferenceProviderConnections)
        .set({
          status,
          healthReason: warnings.length ? warnings.join('; ') : null,
          syncStatus: warnings.length ? 'error' : 'success',
          syncLastError: warnings.length ? warnings.join('; ') : null,
          lastSyncedAt: new Date(),
          nextSyncAt: new Date(Date.now() + SYNC_FRESH_MS),
          updatedAt: new Date(),
        })
        .where(eq(inferenceProviderConnections.id, connectionId));
    } catch (error) {
      const reauth = isReauthError(error);
      await this.db
        .update(inferenceProviderConnections)
        .set({
          status: reauth ? 'reauth_required' : connection.lastSyncedAt ? 'stale' : 'unavailable',
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

  async setRoutingStrategy(userId: string, providerId: string, routingStrategy: 'balanced' | 'sequential') {
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
    await this.requireConnection(connectionId);
    await this.assertConnectionCanDisable(connectionId);
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

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
    void this.syncDue().catch(() => undefined);
  }

  private async persistModels(
    connectionId: string,
    models: Awaited<ReturnType<InferenceProviderHttpConnector['discoverModels']>>
  ) {
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
        if (!persisted || !model.pricing) continue;
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
