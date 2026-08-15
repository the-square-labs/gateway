import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  inferenceDiscoveredModels,
  inferenceModelAccessRules,
  inferenceModelSources,
  inferenceModels,
  inferencePricingSnapshots,
  inferenceProviderConnections,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { User } from '@/types.js';
import type { InferenceBudgetPolicyService } from '../accounting/inference-budget-policy.js';
import type { InferenceSetupEventsService } from '../inference-setup-events.service.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import type { InferenceProviderRegistry } from '../providers/inference-provider.registry.js';
import { knownProviderModel, pricingFromDiscoveredMetadata } from '../providers/inference-provider-model-catalog.js';
import type { InferenceModelInput, InferenceModelSourceInput, InferencePricingInput } from './inference-model.types.js';
import {
  latestPricing,
  manualSourceAllowed,
  normalizePublicId,
  serializeDiscovered,
  validateDefaultEffort,
  validateModelInput,
  validatePricing,
} from './inference-model.validation.js';
import type { InferenceModelAccessService } from './inference-model-access.service.js';
import { normalizeReasoningEfforts, validateReasoningMap } from './inference-reasoning.service.js';

export type { InferenceModelInput, InferenceModelSourceInput, InferencePricingInput };

@injectable()
export class InferenceModelService {
  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly registry: InferenceProviderRegistry,
    private readonly access: InferenceModelAccessService,
    private readonly audit: AuditService,
    private readonly budgetPolicies: InferenceBudgetPolicyService,
    private readonly setupEvents?: InferenceSetupEventsService
  ) {}

  async listAdmin() {
    const models = await this.db.select().from(inferenceModels).orderBy(asc(inferenceModels.publicId));
    return Promise.all(models.map((model) => this.serializeModel(model)));
  }

  async getAdmin(modelId: string) {
    return this.serializeModel(await this.requireModel(modelId));
  }

  async create(userId: string, input: InferenceModelInput) {
    validateModelInput(input);
    const efforts = normalizeReasoningEfforts(input.reasoningEfforts);
    validateDefaultEffort(efforts, input.defaultReasoningEffort);
    const [model] = await this.db
      .insert(inferenceModels)
      .values({
        ...input,
        publicId: normalizePublicId(input.publicId),
        displayName: input.displayName.trim(),
        reasoningEfforts: efforts,
        defaultReasoningEffort: input.defaultReasoningEffort ?? null,
        subscriptionMultiplier: String(input.subscriptionMultiplier),
        enabled: false,
        createdBy: userId,
      })
      .returning();
    await this.changed(userId, 'inference.model.create', model.id, { publicId: model.publicId });
    return this.serializeModel(model);
  }

  async update(userId: string, modelId: string, input: Partial<InferenceModelInput> & { enabled?: boolean }) {
    const model = await this.requireModel(modelId);
    const next: InferenceModelInput = {
      publicId: input.publicId ?? model.publicId,
      displayName: input.displayName ?? model.displayName,
      contextWindow: input.contextWindow ?? model.contextWindow,
      maxInputTokens: input.maxInputTokens ?? model.maxInputTokens,
      maxOutputTokens: input.maxOutputTokens === undefined ? model.maxOutputTokens : input.maxOutputTokens,
      autoCompactTokenLimit: input.autoCompactTokenLimit ?? model.autoCompactTokenLimit,
      modalities: input.modalities ?? model.modalities,
      capabilities: input.capabilities ?? model.capabilities,
      reasoningEfforts: input.reasoningEfforts ?? model.reasoningEfforts,
      defaultReasoningEffort:
        input.defaultReasoningEffort === undefined ? model.defaultReasoningEffort : input.defaultReasoningEffort,
      defaultAccessAllowed: input.defaultAccessAllowed ?? model.defaultAccessAllowed,
      subscriptionMultiplier: input.subscriptionMultiplier ?? Number(model.subscriptionMultiplier),
    };
    validateModelInput(next);
    next.reasoningEfforts = normalizeReasoningEfforts(next.reasoningEfforts);
    validateDefaultEffort(next.reasoningEfforts, next.defaultReasoningEffort);
    if (input.enabled === true) await this.validatePublish(modelId, next);
    await this.db
      .update(inferenceModels)
      .set({
        ...next,
        publicId: normalizePublicId(next.publicId),
        displayName: next.displayName.trim(),
        subscriptionMultiplier: String(next.subscriptionMultiplier),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        updatedAt: new Date(),
      })
      .where(eq(inferenceModels.id, modelId));
    await this.access.invalidate();
    await this.changed(userId, 'inference.model.update', modelId, { fields: Object.keys(input) });
    return this.serializeModel(await this.requireModel(modelId));
  }

  async remove(userId: string, modelId: string): Promise<void> {
    const model = await this.requireModel(modelId);
    await this.db.delete(inferenceModels).where(eq(inferenceModels.id, modelId));
    await this.access.invalidate();
    await this.changed(userId, 'inference.model.delete', modelId, { publicId: model.publicId });
  }

  async addSource(userId: string, modelId: string, input: InferenceModelSourceInput) {
    const [model, connection] = await Promise.all([
      this.requireModel(modelId),
      this.db.query.inferenceProviderConnections.findFirst({
        where: and(
          eq(inferenceProviderConnections.id, input.connectionId),
          isNull(inferenceProviderConnections.deletedAt)
        ),
      }),
    ]);
    if (!connection) throw new AppError(404, 'INFERENCE_PROVIDER_NOT_FOUND', 'Provider connection not found');
    const provider = this.registry.require(connection.providerId);
    const discovered = input.discoveredModelId
      ? await this.db.query.inferenceDiscoveredModels.findFirst({
          where: and(
            eq(inferenceDiscoveredModels.id, input.discoveredModelId),
            eq(inferenceDiscoveredModels.connectionId, connection.id)
          ),
        })
      : null;
    if (input.discoveredModelId && !discovered) {
      throw new AppError(
        400,
        'INFERENCE_DISCOVERED_MODEL_INVALID',
        'Discovered model does not belong to the connection'
      );
    }
    if (!discovered && !manualSourceAllowed(connection.syncStatus, provider.modelsPath, input.manualMetadata)) {
      throw new AppError(
        400,
        'INFERENCE_MANUAL_SOURCE_NOT_ALLOWED',
        'Manual model IDs require unavailable discovery and complete technical metadata'
      );
    }
    const upstreamModelId = discovered?.remoteModelId ?? input.upstreamModelId?.trim();
    if (!upstreamModelId) throw new AppError(400, 'INFERENCE_UPSTREAM_MODEL_REQUIRED', 'Upstream model ID is required');
    if (input.enabled !== false) {
      await this.assertSingleProviderModel(modelId, connection.providerId, upstreamModelId);
    }
    if (input.enabled !== false) validateReasoningMap(model.reasoningEfforts, input.reasoningEffortMap);
    const sourceType = provider.subscription && connection.authType === 'oauth' ? 'subscription' : 'api';
    const pricing =
      sourceType === 'api'
        ? (pricingFromDiscoveredMetadata(discovered?.metadata) ??
          (discovered ? knownProviderModel(provider.id, discovered.remoteModelId)?.pricing : undefined) ??
          input.pricing)
        : input.pricing;
    if (sourceType === 'api' && input.enabled !== false) validatePricing(pricing);
    const originMetadata = sourceOriginMetadata(provider.family, Boolean(discovered), input.manualMetadata);
    const metadata = {
      ...originMetadata,
      composition: { role: 'primary' as const },
    };

    const source = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(inferenceModelSources)
        .values({
          modelId,
          connectionId: connection.id,
          discoveredModelId: discovered?.id,
          upstreamModelId,
          sourceType,
          enabled: input.enabled ?? true,
          priority: 0,
          subscriptionMultiplierOverride:
            input.subscriptionMultiplierOverride === undefined || input.subscriptionMultiplierOverride === null
              ? null
              : String(input.subscriptionMultiplierOverride),
          reasoningEffortMap: input.reasoningEffortMap,
          capabilitiesOverride: input.capabilitiesOverride,
          metadata,
        })
        .returning();
      if (pricing) await insertPricing(tx, created.id, userId, pricing);
      return created;
    });
    await this.changed(userId, 'inference.model.source.create', source.id, { modelId, connectionId: connection.id });
    return this.serializeModel(await this.requireModel(modelId));
  }

  async updateSource(
    userId: string,
    sourceId: string,
    input: Partial<Pick<InferenceModelSourceInput, 'enabled' | 'reasoningEffortMap' | 'capabilitiesOverride'>>
  ) {
    const source = await this.requireSource(sourceId);
    const model = await this.requireModel(source.modelId);
    const enabled = input.enabled ?? source.enabled;
    if (enabled) {
      const connection = await this.db.query.inferenceProviderConnections.findFirst({
        where: eq(inferenceProviderConnections.id, source.connectionId),
      });
      if (!connection) throw new AppError(404, 'INFERENCE_PROVIDER_NOT_FOUND', 'Provider connection not found');
      await this.assertSingleProviderModel(source.modelId, connection.providerId, source.upstreamModelId);
      validateReasoningMap(model.reasoningEfforts, input.reasoningEffortMap ?? source.reasoningEffortMap);
    }
    if (input.enabled === true && source.sourceType === 'api' && !(await this.hasPricing(sourceId))) {
      throw new AppError(400, 'INFERENCE_PRICING_REQUIRED', 'API source cannot be enabled without versioned pricing');
    }
    await this.db
      .update(inferenceModelSources)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(inferenceModelSources.id, sourceId));
    if (model.enabled) await this.validatePublish(model.id);
    await this.changed(userId, 'inference.model.source.update', sourceId, { fields: Object.keys(input) });
    return this.serializeModel(await this.requireModel(source.modelId));
  }

  async removeSource(userId: string, sourceId: string): Promise<void> {
    const source = await this.requireSource(sourceId);
    const model = await this.requireModel(source.modelId);
    if (model.enabled && source.enabled && sourceRole(source) === 'primary') {
      const siblings = await this.db.query.inferenceModelSources.findMany({
        where: eq(inferenceModelSources.modelId, source.modelId),
      });
      const hasAnotherPrimary = siblings.some(
        (candidate) => candidate.id !== source.id && candidate.enabled && sourceRole(candidate) === 'primary'
      );
      if (!hasAnotherPrimary) {
        throw new AppError(
          400,
          'INFERENCE_MODEL_SOURCE_REQUIRED',
          'A published model must keep at least one enabled primary source'
        );
      }
    }
    await this.db.delete(inferenceModelSources).where(eq(inferenceModelSources.id, sourceId));
    await this.changed(userId, 'inference.model.source.delete', sourceId, { modelId: source.modelId });
  }

  async addPricing(userId: string, sourceId: string, input: InferencePricingInput) {
    const source = await this.requireSource(sourceId);
    validatePricing(input);
    await insertPricing(this.db, sourceId, userId, input);
    await this.changed(userId, 'inference.model.pricing.create', sourceId, { version: input.version });
    return this.serializeModel(await this.requireModel(source.modelId));
  }

  async setAccess(
    userId: string,
    modelId: string,
    input: {
      mode: 'everyone' | 'selected' | 'disabled';
      subjects: Array<{ subjectType: 'group' | 'user'; subjectId: string }>;
    }
  ) {
    await this.requireModel(modelId);
    if (input.mode === 'selected' && input.subjects.length === 0) {
      throw new AppError(400, 'INFERENCE_MODEL_ACCESS_EMPTY', 'Selected access requires at least one user or group');
    }
    if (input.mode !== 'disabled') await this.validatePublish(modelId);
    const unique = new Map(input.subjects.map((subject) => [`${subject.subjectType}:${subject.subjectId}`, subject]));
    await this.db.transaction(async (tx) => {
      await tx.delete(inferenceModelAccessRules).where(eq(inferenceModelAccessRules.modelId, modelId));
      if (input.mode === 'selected') {
        await tx.insert(inferenceModelAccessRules).values(
          [...unique.values()].map((subject) => ({
            modelId,
            subjectType: subject.subjectType,
            groupId: subject.subjectType === 'group' ? subject.subjectId : null,
            userId: subject.subjectType === 'user' ? subject.subjectId : null,
            effect: 'allow' as const,
            createdBy: userId,
          }))
        );
      }
      await tx
        .update(inferenceModels)
        .set({
          enabled: input.mode !== 'disabled',
          defaultAccessAllowed: input.mode === 'everyone',
          updatedAt: new Date(),
        })
        .where(eq(inferenceModels.id, modelId));
    });
    await this.access.invalidate();
    await this.changed(userId, 'inference.model.access.update', modelId, {
      mode: input.mode,
      subjectCount: unique.size,
    });
    return this.serializeModel(await this.requireModel(modelId));
  }

  async suggestions(modelId: string) {
    const sources = await this.db
      .select({ source: inferenceModelSources, connection: inferenceProviderConnections })
      .from(inferenceModelSources)
      .innerJoin(inferenceProviderConnections, eq(inferenceModelSources.connectionId, inferenceProviderConnections.id))
      .where(eq(inferenceModelSources.modelId, modelId));
    if (!sources.length) return [];
    const providerId = sources[0]!.connection.providerId;
    const upstreamModelId = sources[0]!.source.upstreamModelId;
    const attached = new Set(sources.map(({ source }) => `${source.connectionId}:${source.upstreamModelId}`));
    const connections = await this.db
      .select()
      .from(inferenceProviderConnections)
      .where(and(eq(inferenceProviderConnections.enabled, true), isNull(inferenceProviderConnections.deletedAt)));
    const compatibleIds = connections
      .filter((connection) => connection.providerId === providerId)
      .map((connection) => connection.id);
    if (!compatibleIds.length) return [];
    const models = await this.db
      .select()
      .from(inferenceDiscoveredModels)
      .where(
        and(
          inArray(inferenceDiscoveredModels.connectionId, compatibleIds),
          eq(inferenceDiscoveredModels.available, true)
        )
      );
    return models
      .filter(
        (model) =>
          model.remoteModelId === upstreamModelId && !attached.has(`${model.connectionId}:${model.remoteModelId}`)
      )
      .map(serializeDiscovered);
  }

  async listForUser(user: User) {
    const allowed = await this.access.allowedModelIds(user);
    if (!allowed.size) return { object: 'list', data: [] };
    const availability = await this.modelAvailabilityForUser(user.id, [...allowed]);
    if (!availability.modelIds.length) return { object: 'list', data: [] };
    const models = await this.db
      .select()
      .from(inferenceModels)
      .where(and(eq(inferenceModels.enabled, true), inArray(inferenceModels.id, availability.modelIds)))
      .orderBy(asc(inferenceModels.publicId));
    const data = await Promise.all(models.map((model) => this.publicModel(model, availability.apiUsageEnabled)));
    return { object: 'list', data };
  }

  async resolveForUser(user: User, publicId: string) {
    const model = await this.db.query.inferenceModels.findFirst({ where: eq(inferenceModels.publicId, publicId) });
    if (!model?.enabled || !(await this.access.canAccess(user, model.id))) {
      throw new InferenceProtocolError(404, 'model_not_found', `Model "${publicId}" is not available`);
    }
    const availability = await this.modelAvailabilityForUser(user.id, [model.id]);
    if (!availability.modelIds.length) {
      throw new InferenceProtocolError(404, 'model_not_found', `Model "${publicId}" is not available`);
    }
    const full = await this.serializeModel(model);
    return {
      model,
      sources: filterSourcesByApiUsage(full.sources, availability.apiUsageEnabled),
    };
  }

  private async modelAvailabilityForUser(
    userId: string,
    modelIds: string[]
  ): Promise<{ modelIds: string[]; apiUsageEnabled: boolean }> {
    if (!modelIds.length) return { modelIds: [], apiUsageEnabled: false };
    const limits = await this.budgetPolicies.effective(userId);
    if (!limits.enabled) return { modelIds: [], apiUsageEnabled: false };
    if (limits.apiMonthlyMicrodollars > 0) {
      return { modelIds, apiUsageEnabled: true };
    }

    const subscriptionSources = await this.db
      .select({ modelId: inferenceModelSources.modelId })
      .from(inferenceModelSources)
      .innerJoin(inferenceProviderConnections, eq(inferenceModelSources.connectionId, inferenceProviderConnections.id))
      .where(
        and(
          inArray(inferenceModelSources.modelId, modelIds),
          eq(inferenceModelSources.enabled, true),
          eq(inferenceModelSources.sourceType, 'subscription'),
          eq(inferenceProviderConnections.enabled, true)
        )
      );
    return {
      modelIds: filterModelIdsByApiBudget(
        modelIds,
        subscriptionSources.map((source) => source.modelId),
        limits.apiMonthlyMicrodollars
      ),
      apiUsageEnabled: false,
    };
  }

  private async validatePublish(modelId: string, candidate?: InferenceModelInput) {
    const model = candidate ?? (await this.requireModel(modelId));
    const sources = await this.db
      .select({ source: inferenceModelSources, connection: inferenceProviderConnections })
      .from(inferenceModelSources)
      .innerJoin(inferenceProviderConnections, eq(inferenceModelSources.connectionId, inferenceProviderConnections.id))
      .where(and(eq(inferenceModelSources.modelId, modelId), eq(inferenceModelSources.enabled, true)));
    if (!sources.length)
      throw new AppError(400, 'INFERENCE_MODEL_SOURCE_REQUIRED', 'Published model needs an enabled source');
    assertSingleProviderBindings(
      sources.map(({ source, connection }) => ({
        providerId: connection.providerId,
        upstreamModelId: source.upstreamModelId,
        role: sourceRole(source),
      }))
    );
    for (const { source } of sources) {
      validateReasoningMap(model.reasoningEfforts, source.reasoningEffortMap);
      if (source.sourceType === 'api' && !(await this.hasPricing(source.id))) {
        throw new AppError(400, 'INFERENCE_PRICING_REQUIRED', 'Every enabled API source needs versioned pricing');
      }
    }
    const limits = await this.safeLimits(modelId, model);
    if (model.contextWindow > limits.contextWindow || model.maxInputTokens > limits.maxInputTokens) {
      throw new AppError(400, 'INFERENCE_MODEL_LIMIT_UNSAFE', 'Published limits exceed an enabled source safe limit');
    }
  }

  private async assertSingleProviderModel(modelId: string, providerId: string, upstreamModelId: string) {
    const sources = await this.db
      .select({ source: inferenceModelSources, connection: inferenceProviderConnections })
      .from(inferenceModelSources)
      .innerJoin(inferenceProviderConnections, eq(inferenceModelSources.connectionId, inferenceProviderConnections.id))
      .where(and(eq(inferenceModelSources.modelId, modelId), eq(inferenceModelSources.enabled, true)));
    assertSingleProviderBindings(
      sources.map(({ source, connection }) => ({
        providerId: connection.providerId,
        upstreamModelId: source.upstreamModelId,
        role: sourceRole(source),
      })),
      { providerId, upstreamModelId, role: 'primary' }
    );
  }

  private async safeLimits(
    modelId: string,
    model: Pick<InferenceModelInput, 'contextWindow' | 'maxInputTokens' | 'maxOutputTokens' | 'autoCompactTokenLimit'>,
    apiUsageEnabled = true
  ) {
    const conditions = [eq(inferenceModelSources.modelId, modelId), eq(inferenceModelSources.enabled, true)];
    if (!apiUsageEnabled) conditions.push(eq(inferenceModelSources.sourceType, 'subscription'));
    const sources = await this.db
      .select({ source: inferenceModelSources, discovered: inferenceDiscoveredModels })
      .from(inferenceModelSources)
      .leftJoin(inferenceDiscoveredModels, eq(inferenceModelSources.discoveredModelId, inferenceDiscoveredModels.id))
      .where(and(...conditions));
    const technical = sources
      .filter(({ source }) => sourceRole(source) === 'primary')
      .map(({ source, discovered }) => {
        const manual = source.metadata.technical as Partial<typeof model> | undefined;
        return {
          contextWindow: manual?.contextWindow ?? discovered?.contextWindow ?? model.contextWindow,
          maxInputTokens: manual?.maxInputTokens ?? discovered?.maxInputTokens ?? model.maxInputTokens,
          maxOutputTokens: manual?.maxOutputTokens ?? discovered?.maxOutputTokens ?? model.maxOutputTokens,
          autoCompactTokenLimit:
            manual?.autoCompactTokenLimit ?? discovered?.autoCompactTokenLimit ?? model.autoCompactTokenLimit,
        };
      });
    return effectiveTechnicalLimits(technical, model);
  }

  private async publicModel(model: typeof inferenceModels.$inferSelect, apiUsageEnabled = true) {
    const [limits, sourceState] = await Promise.all([
      this.safeLimits(model.id, model, apiUsageEnabled),
      this.sourceState(model.id, model.capabilities, apiUsageEnabled),
    ]);
    return {
      id: model.publicId,
      object: 'model',
      created: Math.floor(model.createdAt.getTime() / 1000),
      owned_by: 'gateway',
      display_name: model.displayName,
      context_window: limits.contextWindow,
      max_input_tokens: limits.maxInputTokens,
      ...(limits.maxOutputTokens === null ? {} : { max_output_tokens: limits.maxOutputTokens }),
      auto_compact_token_limit: limits.autoCompactTokenLimit,
      input_modalities: model.modalities,
      capabilities: sourceState.capabilities.effective,
      supported_reasoning_efforts: model.reasoningEfforts,
      default_reasoning_effort: model.defaultReasoningEffort,
      supported_service_tiers: sourceState.supportsFast ? ['priority'] : [],
    };
  }

  private async serializeModel(model: typeof inferenceModels.$inferSelect) {
    const limits = await this.safeLimits(model.id, model);
    const sources = await this.db
      .select({
        source: inferenceModelSources,
        connection: inferenceProviderConnections,
        discovered: inferenceDiscoveredModels,
      })
      .from(inferenceModelSources)
      .innerJoin(inferenceProviderConnections, eq(inferenceModelSources.connectionId, inferenceProviderConnections.id))
      .leftJoin(inferenceDiscoveredModels, eq(inferenceModelSources.discoveredModelId, inferenceDiscoveredModels.id))
      .where(eq(inferenceModelSources.modelId, model.id))
      .orderBy(asc(inferenceModelSources.priority));
    const pricing = sources.length
      ? await this.db
          .select()
          .from(inferencePricingSnapshots)
          .where(
            inArray(
              inferencePricingSnapshots.sourceId,
              sources.map(({ source }) => source.id)
            )
          )
          .orderBy(desc(inferencePricingSnapshots.effectiveAt))
      : [];
    const rules = await this.db
      .select()
      .from(inferenceModelAccessRules)
      .where(eq(inferenceModelAccessRules.modelId, model.id));
    const capabilityState = detectedCapabilityState(model.capabilities, sources);
    return {
      ...model,
      ...limits,
      configuredCapabilities: model.capabilities,
      capabilities: capabilityState.effective,
      capabilityLimitations: capabilityState.limitations,
      accessMode: !model.enabled ? 'disabled' : model.defaultAccessAllowed ? 'everyone' : 'selected',
      accessSubjects: rules
        .filter((rule) => rule.effect === 'allow')
        .map((rule) => ({
          subjectType: rule.subjectType,
          subjectId: rule.subjectType === 'group' ? rule.groupId : rule.userId,
        }))
        .filter((subject): subject is { subjectType: 'group' | 'user'; subjectId: string } =>
          Boolean(subject.subjectId)
        ),
      subscriptionMultiplier: Number(model.subscriptionMultiplier),
      createdAt: model.createdAt.toISOString(),
      updatedAt: model.updatedAt.toISOString(),
      sources: sources.map(({ source, connection, discovered }) => ({
        ...source,
        subscriptionMultiplierOverride: source.subscriptionMultiplierOverride
          ? Number(source.subscriptionMultiplierOverride)
          : null,
        providerId: connection.providerId,
        connectionName: connection.name,
        capabilities: source.capabilitiesOverride ?? discovered?.capabilities ?? {},
        reasoningEfforts: discovered?.reasoningEfforts ?? [],
        contextWindow: discovered?.contextWindow ?? null,
        maxInputTokens: discovered?.maxInputTokens ?? null,
        maxOutputTokens: discovered?.maxOutputTokens ?? null,
        autoCompactTokenLimit: discovered?.autoCompactTokenLimit ?? null,
        modalities: discovered?.modalities ?? [],
        pricing: latestPricing(pricing.filter((row) => row.sourceId === source.id)),
        createdAt: source.createdAt.toISOString(),
        updatedAt: source.updatedAt.toISOString(),
      })),
      accessRules: rules,
    };
  }

  private async sourceState(modelId: string, configured: Record<string, boolean>, apiUsageEnabled = true) {
    const conditions = [eq(inferenceModelSources.modelId, modelId)];
    if (!apiUsageEnabled) conditions.push(eq(inferenceModelSources.sourceType, 'subscription'));
    const sources = await this.db
      .select({
        source: inferenceModelSources,
        connection: inferenceProviderConnections,
        discovered: inferenceDiscoveredModels,
      })
      .from(inferenceModelSources)
      .innerJoin(inferenceProviderConnections, eq(inferenceModelSources.connectionId, inferenceProviderConnections.id))
      .leftJoin(inferenceDiscoveredModels, eq(inferenceModelSources.discoveredModelId, inferenceDiscoveredModels.id))
      .where(and(...conditions));
    return {
      capabilities: detectedCapabilityState(configured, sources),
      supportsFast: supportsFastServiceTier(sources),
    };
  }

  private async hasPricing(sourceId: string): Promise<boolean> {
    const pricing = await this.db.query.inferencePricingSnapshots.findFirst({
      where: eq(inferencePricingSnapshots.sourceId, sourceId),
      orderBy: [desc(inferencePricingSnapshots.effectiveAt)],
    });
    return Boolean(
      pricing && pricing.inputMicrodollarsPerMillion !== null && pricing.outputMicrodollarsPerMillion !== null
    );
  }

  private async requireModel(modelId: string) {
    const model = await this.db.query.inferenceModels.findFirst({ where: eq(inferenceModels.id, modelId) });
    if (!model) throw new AppError(404, 'INFERENCE_MODEL_NOT_FOUND', 'Inference model not found');
    return model;
  }

  private async requireSource(sourceId: string) {
    const source = await this.db.query.inferenceModelSources.findFirst({
      where: eq(inferenceModelSources.id, sourceId),
    });
    if (!source) throw new AppError(404, 'INFERENCE_MODEL_SOURCE_NOT_FOUND', 'Inference model source not found');
    return source;
  }

  private async changed(userId: string, action: string, resourceId: string, details?: Record<string, unknown>) {
    await this.audit.log({ userId, action, resourceType: 'inference_model', resourceId, details });
    this.setupEvents?.publishCatalogChanged();
  }
}

interface CapabilitySourceRow {
  source: typeof inferenceModelSources.$inferSelect;
  connection: typeof inferenceProviderConnections.$inferSelect;
  discovered: typeof inferenceDiscoveredModels.$inferSelect | null;
}

function detectedCapabilityState(configured: Record<string, boolean>, rows: CapabilitySourceRow[]) {
  const sources = rows.filter(({ source }) => source.enabled && sourceRole(source) === 'primary');
  if (!sources.length) return { effective: configured, limitations: {} as Record<string, string[]> };
  const keys = new Set(Object.keys(configured));
  for (const { source, discovered } of sources) {
    for (const key of Object.keys(source.capabilitiesOverride ?? discovered?.capabilities ?? {})) keys.add(key);
  }
  const effective: Record<string, boolean> = {};
  const limitations: Record<string, string[]> = {};
  for (const key of [...keys].sort()) {
    const missing = sources.filter(({ source, discovered }) => {
      const capabilities = source.capabilitiesOverride ?? discovered?.capabilities ?? {};
      return capabilities[key] !== true;
    });
    effective[key] = missing.length === 0;
    if (missing.length) {
      limitations[key] = missing.map(({ source, connection }) => `${connection.name} · ${source.upstreamModelId}`);
    }
  }
  return { effective, limitations };
}

function supportsFastServiceTier(rows: CapabilitySourceRow[]): boolean {
  const sources = rows.filter(({ source }) => source.enabled && sourceRole(source) === 'primary');
  return (
    sources.length > 0 &&
    sources.every(({ source, connection, discovered }) => {
      if (source.sourceType !== 'subscription' || connection.providerId !== 'openai' || !discovered) return false;
      const serviceTiers = Array.isArray(discovered.metadata.service_tiers) ? discovered.metadata.service_tiers : [];
      const additionalSpeedTiers = Array.isArray(discovered.metadata.additional_speed_tiers)
        ? discovered.metadata.additional_speed_tiers
        : [];
      return (
        serviceTiers.some(
          (tier) =>
            tier && typeof tier === 'object' && !Array.isArray(tier) && (tier as { id?: unknown }).id === 'priority'
        ) || additionalSpeedTiers.includes('fast')
      );
    })
  );
}

function sourceRole(source: typeof inferenceModelSources.$inferSelect): 'primary' | 'vision_sidecar' {
  const composition = source.metadata.composition;
  if (composition && typeof composition === 'object' && !Array.isArray(composition)) {
    return (composition as { role?: unknown }).role === 'vision_sidecar' ? 'vision_sidecar' : 'primary';
  }
  return 'primary';
}

interface ProviderBinding {
  providerId: string;
  upstreamModelId: string;
  role: 'primary' | 'vision_sidecar';
}

function assertSingleProviderBindings(bindings: ProviderBinding[], expected = bindings[0]): void {
  if (!expected) return;
  if (
    bindings.some(
      (binding) =>
        binding.role !== 'primary' ||
        binding.providerId !== expected.providerId ||
        binding.upstreamModelId !== expected.upstreamModelId
    )
  ) {
    throw new AppError(
      400,
      'INFERENCE_MODEL_PROVIDER_REQUIRED',
      'A logical model must use one provider and one upstream model'
    );
  }
}

function sourceOriginMetadata(
  providerFamily: string,
  discovered: boolean,
  technical?: InferenceModelSourceInput['manualMetadata']
) {
  return {
    origin: discovered ? ('discovery' as const) : ('manual' as const),
    providerFamily,
    ...(technical ? { technical } : {}),
  };
}

function filterModelIdsByApiBudget(
  modelIds: readonly string[],
  subscriptionSourceModelIds: readonly string[],
  apiMonthlyMicrodollars: number
): string[] {
  if (apiMonthlyMicrodollars > 0) return [...modelIds];
  const subscriptionModels = new Set(subscriptionSourceModelIds);
  return modelIds.filter((modelId) => subscriptionModels.has(modelId));
}

function filterSourcesByApiUsage<T extends { sourceType: string }>(
  sources: readonly T[],
  apiUsageEnabled: boolean
): T[] {
  return apiUsageEnabled ? [...sources] : sources.filter((source) => source.sourceType === 'subscription');
}

type TransactionLike = Pick<DrizzleClient, 'insert'>;

async function insertPricing(tx: TransactionLike, sourceId: string, userId: string, input: InferencePricingInput) {
  validatePricing(input);
  await tx.insert(inferencePricingSnapshots).values({
    sourceId,
    version: input.version.trim(),
    inputMicrodollarsPerMillion: input.inputMicrodollarsPerMillion,
    cachedInputMicrodollarsPerMillion: input.cachedInputMicrodollarsPerMillion,
    cacheWriteMicrodollarsPerMillion: input.cacheWriteMicrodollarsPerMillion,
    outputMicrodollarsPerMillion: input.outputMicrodollarsPerMillion,
    reasoningMicrodollarsPerMillion: input.reasoningMicrodollarsPerMillion,
    otherUnitPrices: input.otherUnitPrices ?? {},
    source: input.source,
    createdBy: userId,
  });
}

export const __testOnly = {
  normalizePublicId,
  validateModelInput,
  validatePricing,
  manualSourceAllowed,
  detectedCapabilityState,
  supportsFastServiceTier,
  assertSingleProviderBindings,
  sourceOriginMetadata,
  filterModelIdsByApiBudget,
  filterSourcesByApiUsage,
  effectiveTechnicalLimits,
};

type TechnicalLimits = Pick<
  InferenceModelInput,
  'contextWindow' | 'maxInputTokens' | 'maxOutputTokens' | 'autoCompactTokenLimit'
>;

function effectiveTechnicalLimits(sources: TechnicalLimits[], fallback: TechnicalLimits) {
  const effective = sources.length ? sources : [fallback];
  const outputLimits = effective.map((row) => row.maxOutputTokens).filter((value): value is number => value !== null);
  const contextWindow = Math.min(...effective.map((row) => row.contextWindow));
  const maxInputTokens = Math.min(...effective.map((row) => row.maxInputTokens));
  return {
    contextWindow,
    maxInputTokens,
    maxOutputTokens: outputLimits.length ? Math.min(...outputLimits) : null,
    autoCompactTokenLimit: Math.min(maxInputTokens, ...effective.map((row) => row.autoCompactTokenLimit)),
  };
}
