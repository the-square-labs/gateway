import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { inferenceDiscoveredModels, inferenceModelSources, inferenceProviderConnections } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { InferenceAccountingService, InferenceAdmission } from './accounting/inference-accounting.service.js';
import type { InferenceModelService } from './models/inference-model.service.js';
import { mapReasoningEffort } from './models/inference-reasoning.service.js';
import { InferenceProtocolError } from './protocol/inference-protocol.error.js';
import type {
  InferenceExecution,
  InferenceExecutionContext,
  InferenceExecutor,
  InferenceRequest,
  InferenceStreamEvent,
  InferenceUsage,
} from './protocol/inference-protocol.types.js';
import { estimateInputTokens } from './protocol/inference-usage.js';
import type { InferenceDestinationPolicy } from './providers/inference-destination-policy.js';
import type { InferenceProviderRegistry } from './providers/inference-provider.registry.js';
import type { InferenceProviderCredentialService } from './providers/inference-provider-credential.service.js';
import type { InferenceProviderHttpConnector } from './providers/inference-provider-http.connector.js';
import { canFailOver, type InferenceRoutingService } from './providers/inference-routing.service.js';

interface SourceCandidate {
  source: typeof inferenceModelSources.$inferSelect;
  connection: typeof inferenceProviderConnections.$inferSelect;
  discovered?: typeof inferenceDiscoveredModels.$inferSelect | null;
}

@injectable()
export class InferenceGatewayExecutor implements InferenceExecutor {
  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly models: InferenceModelService,
    private readonly routing: InferenceRoutingService,
    private readonly accounting: InferenceAccountingService,
    private readonly credentials: InferenceProviderCredentialService,
    private readonly registry: InferenceProviderRegistry,
    private readonly connector: InferenceProviderHttpConnector,
    private readonly destinations: InferenceDestinationPolicy
  ) {}

  async execute(request: InferenceRequest, context: InferenceExecutionContext): Promise<InferenceExecution> {
    const user = await this.requireUser(context.userId);
    const resolved = await this.models.resolveForUser(user, request.model);
    const candidates = await this.candidates(resolved.model.id);
    assertSingleProviderModel(candidates);
    let lastError: unknown;
    let retryOf: InferenceAdmission | undefined;
    const attempted = new Set<string>();
    for (let attempt = 0; attempt < candidates.length; attempt += 1) {
      let admission: InferenceAdmission | null = null;
      let selected: SourceCandidate | null = null;
      let dispatched = false;
      try {
        selected = await this.selectCandidate(candidates, context, attempted, resolved.model.id);
        if (!selected) break;
        attempted.add(selected.connection.id);
        const mappedRequest = mapRequestReasoning(request, resolved.model, selected.source);
        if (hasImages(mappedRequest) && !candidateHasVision(selected, resolved.model.capabilities)) {
          throw new InferenceProtocolError(
            400,
            'unsupported_image_input',
            'The selected provider model does not support image input'
          );
        }
        admission = await this.accounting.admit({
          userId: context.userId,
          tokenId: context.tokenId,
          protocol: request.protocol,
          request: mappedRequest,
          model: resolved.model,
          source: selected.source,
          connection: selected.connection,
          operation: context.operation,
          apiUnitCharge: context.apiUnitCharge,
          retryOf,
        });
        const admittedRequest = applyAdmissionOutputLimit(mappedRequest, admission);
        const definition = this.registry.require(selected.connection.providerId);
        const requiredOperation = context.operation === 'search' ? 'search' : 'inference';
        if (!(definition.supportedOperations ?? ['inference']).includes(requiredOperation)) {
          throw new InferenceProtocolError(
            503,
            'operation_unavailable',
            `Provider does not support ${requiredOperation}`
          );
        }
        await this.destinations.assertAllowed(
          selected.connection.baseUrl,
          selected.connection.metadata.allowPrivateNetwork === true
        );
        const credential = await this.credentials.get(selected.connection.id);
        await this.accounting.markDispatched(admission);
        dispatched = true;
        const upstream = await this.connector.execute(
          definition,
          credential,
          selected.connection.baseUrl,
          selected.source.upstreamModelId,
          admittedRequest,
          context.signal,
          selected.connection.metadata.allowPrivateNetwork === true
        );
        return {
          responseId: upstream.responseId || `resp_${randomUUID()}`,
          resolvedModel: resolved.model.publicId,
          affinityKey: context.affinityKey,
          events: this.accountedEvents(admittedRequest, admission, upstream.events),
        };
      } catch (error) {
        lastError = error;
        const retryable = canFailOver(normalizeError(error), dispatched);
        if (admission) {
          if (retryable) {
            await this.accounting.failForRetry(admission, error);
            retryOf = admission;
          } else {
            await this.accounting.fail(admission, error, false);
          }
        }
        if (!retryable) throw error;
        if (selected && error instanceof InferenceProtocolError && error.code === 'provider_rate_limited') {
          await this.routing.markCooldown(selected.connection.id, 30, 'Provider rate limited');
        }
        if (error instanceof InferenceProtocolError && error.code === 'subscription_budget_exhausted') break;
      }
    }
    if (retryOf) await this.accounting.finishRetry(retryOf, lastError);
    throw normalizeError(lastError);
  }

  private async *accountedEvents(
    request: InferenceRequest,
    admission: InferenceAdmission,
    upstream: AsyncIterable<InferenceStreamEvent>
  ): AsyncIterable<InferenceStreamEvent> {
    let emittedOutput = false;
    let settled = false;
    let terminalReceived = false;
    let outputCharacters = 0;
    try {
      for await (const event of upstream) {
        if (terminalReceived) {
          throw new InferenceProtocolError(
            502,
            'upstream_stream_invalid',
            'Upstream emitted data after the terminal event'
          );
        }
        if (event.type === 'output_text.delta' || event.type === 'reasoning.delta') {
          emittedOutput = true;
          outputCharacters += event.delta.length;
        } else if (event.type === 'tool_call.delta' || event.type === 'item.done') {
          emittedOutput = true;
          outputCharacters += event.type === 'tool_call.delta' ? event.delta.length : JSON.stringify(event.item).length;
        }
        if (event.type === 'error') {
          throw new InferenceProtocolError(502, event.code, event.message);
        }
        if (event.type === 'completed') {
          terminalReceived = true;
          const usage = terminalUsage(event.usage, request, outputCharacters);
          await this.accounting.settle(
            admission,
            usage,
            emittedOutput,
            event.status === undefined || event.status === 'completed' ? 'completed' : 'failed'
          );
          settled = true;
          yield { ...event, usage };
          continue;
        }
        yield event;
      }
      if (!terminalReceived) {
        throw new InferenceProtocolError(
          502,
          'upstream_stream_incomplete',
          'Upstream stream ended without a terminal event'
        );
      }
    } catch (error) {
      if (!settled) {
        if (emittedOutput) {
          await this.accounting.settle(admission, terminalUsage(undefined, request, outputCharacters), true, 'failed');
        } else {
          await this.accounting.fail(admission, error, false);
        }
      }
      settled = true;
      throw error;
    } finally {
      if (!settled) {
        if (emittedOutput)
          await this.accounting.settle(admission, terminalUsage(undefined, request, outputCharacters), true, 'failed');
        else await this.accounting.fail(admission, new Error('Upstream ended without output'), false);
      }
    }
  }

  private async selectCandidate(
    compatible: SourceCandidate[],
    context: InferenceExecutionContext,
    attempted: Set<string>,
    modelId: string
  ): Promise<SourceCandidate | null> {
    const remaining = compatible.filter((row) => !attempted.has(row.connection.id));
    if (!remaining.length) return null;
    const selection = await this.routing.select({
      providerId: remaining[0]!.connection.providerId,
      allowedConnectionIds: remaining.map((row) => row.connection.id),
      affinityKey: context.affinityKey ? `${context.userId}:${modelId}:${context.affinityKey}` : undefined,
      existingThread: context.existingThread === true,
    });
    return remaining.find((row) => row.connection.id === selection.connectionId) ?? null;
  }

  private async candidates(modelId: string): Promise<SourceCandidate[]> {
    const rows = await this.db
      .select({
        source: inferenceModelSources,
        connection: inferenceProviderConnections,
        discovered: inferenceDiscoveredModels,
      })
      .from(inferenceModelSources)
      .innerJoin(inferenceProviderConnections, eq(inferenceModelSources.connectionId, inferenceProviderConnections.id))
      .leftJoin(inferenceDiscoveredModels, eq(inferenceModelSources.discoveredModelId, inferenceDiscoveredModels.id))
      .where(
        and(
          eq(inferenceModelSources.modelId, modelId),
          eq(inferenceModelSources.enabled, true),
          eq(inferenceProviderConnections.enabled, true)
        )
      )
      .orderBy(asc(inferenceModelSources.priority));
    return rows;
  }

  private async requireUser(userId: string) {
    const user = await this.db.query.users.findFirst({ where: (users, { eq }) => eq(users.id, userId) });
    if (!user) throw new InferenceProtocolError(401, 'invalid_api_key', 'Inference user is unavailable');
    const group = await this.db.query.permissionGroups.findFirst({
      where: (groups, { eq }) => eq(groups.id, user.groupId),
    });
    return {
      ...user,
      groupName: group?.name ?? '',
      groupScopes: group?.scopes ?? [],
      scopes: [...new Set([...(group?.scopes ?? []), ...(user.additionalScopes ?? [])])],
    };
  }
}

function mapRequestReasoning(
  request: InferenceRequest,
  model: { reasoningEfforts: string[]; defaultReasoningEffort: string | null },
  source: typeof inferenceModelSources.$inferSelect
): InferenceRequest {
  if (request.protocol === 'messages' && request.reasoningConfig) return request;
  const mapped = mapReasoningEffort(
    request.reasoningEffort,
    model.defaultReasoningEffort,
    model.reasoningEfforts,
    source.reasoningEffortMap
  );
  return { ...request, reasoningEffort: mapped.upstreamEffort };
}

function terminalUsage(
  usage: Partial<InferenceUsage> | undefined,
  request: InferenceRequest,
  outputCharacters: number
): InferenceUsage {
  const inputTokens = usage?.inputTokens ?? estimateInputTokens(request.messages);
  const outputTokens = usage?.outputTokens ?? Math.max(1, Math.ceil(outputCharacters / 3));
  const reasoningTokens = usage?.reasoningTokens ?? 0;
  const computedTotal = inputTokens + outputTokens + reasoningTokens;
  return {
    inputTokens,
    cachedInputTokens: usage?.cachedInputTokens ?? 0,
    cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
    outputTokens,
    reasoningTokens,
    totalTokens: Math.max(usage?.totalTokens ?? computedTotal, computedTotal),
    estimated: usage?.estimated ?? !usage,
  };
}

function hasImages(request: InferenceRequest): boolean {
  return request.messages.some((message) => message.content.some((part) => part.type === 'image'));
}

function composition(source: typeof inferenceModelSources.$inferSelect): {
  role: 'primary' | 'vision_sidecar';
  primarySourceId?: string;
} {
  const raw = source.metadata.composition;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { role: 'primary' };
  const value = raw as { role?: unknown; primarySourceId?: unknown };
  return {
    role: value.role === 'vision_sidecar' ? 'vision_sidecar' : 'primary',
    ...(typeof value.primarySourceId === 'string' ? { primarySourceId: value.primarySourceId } : {}),
  };
}

function assertSingleProviderModel(candidates: SourceCandidate[]): void {
  const first = candidates[0];
  if (!first) return;
  if (
    candidates.some(
      (candidate) =>
        candidate.connection.providerId !== first.connection.providerId ||
        candidate.source.upstreamModelId !== first.source.upstreamModelId ||
        composition(candidate.source).role !== 'primary'
    )
  ) {
    throw new InferenceProtocolError(
      503,
      'model_configuration_invalid',
      'A logical model must use one provider and one upstream model'
    );
  }
}

function candidateHasVision(candidate: SourceCandidate, fallback: Record<string, boolean>): boolean {
  return (
    candidate.source.capabilitiesOverride?.vision ??
    candidate.discovered?.capabilities.vision ??
    fallback.vision ??
    false
  );
}

function normalizeError(error: unknown): InferenceProtocolError {
  if (error instanceof InferenceProtocolError) return error;
  if (error instanceof AppError) {
    return new InferenceProtocolError(
      error.statusCode as InferenceProtocolError['status'],
      error.code.toLowerCase(),
      error.message
    );
  }
  return new InferenceProtocolError(502, 'upstream_error', 'Upstream inference request failed');
}

function applyAdmissionOutputLimit(request: InferenceRequest, admission: InferenceAdmission): InferenceRequest {
  return admission.admittedMaxOutputTokens === undefined
    ? request
    : { ...request, maxOutputTokens: admission.admittedMaxOutputTokens };
}

export const __testOnly = {
  applyAdmissionOutputLimit,
  terminalUsage,
  mapRequestReasoning,
  hasImages,
  composition,
  assertSingleProviderModel,
  normalizeError,
};
