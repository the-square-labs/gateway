import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { Context } from 'hono';
import { injectable } from 'tsyringe';
import type { DrizzleClient } from '@/db/client.js';
import {
  inferenceDiscoveredModels,
  inferenceModelSources,
  inferencePricingSnapshots,
  inferenceProviderConnections,
} from '@/db/schema/index.js';
import type { AppEnv, User } from '@/types.js';
import type { InferenceCoreAccountingService } from '../accounting/inference-core-accounting.service.js';
import type { InferenceAccountingService } from '../accounting/inference-accounting.service.js';
import { unitCharge } from '../accounting/inference-accounting.helpers.js';
import type { InferenceModelService } from '../models/inference-model.service.js';
import { mapReasoningEffort } from '../models/inference-reasoning.service.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import { canFailOver, type InferenceRoutingService } from '../providers/inference-routing.service.js';
import type { InferenceCoreBridgeService } from './inference-core-bridge.service.js';
import { coreRequestHeaders, newCoreRequestContext } from './inference-core-context.js';
import { CORE_ACCOUNT_METADATA_KEY } from './inference-core-provider-map.js';

type SourceCandidate = {
  source: typeof inferenceModelSources.$inferSelect;
  connection: typeof inferenceProviderConnections.$inferSelect;
};

/** Endpoint classes the proxy distinguishes (billing/rewrite behavior differ). */
export type CoreProxyOperation =
  | 'responses'
  | 'responses/compact'
  | 'chat/completions'
  | 'messages'
  | 'messages/count_tokens'
  | 'images/generations'
  | 'images/edits'
  | 'alpha/search'
  | 'live'
  | 'realtime/calls';

const OPERATION_PROTOCOL: Record<CoreProxyOperation, 'responses' | 'chat_completions' | 'messages' | 'images' | 'search' | 'realtime'> = {
  responses: 'responses',
  'responses/compact': 'responses',
  'chat/completions': 'chat_completions',
  messages: 'messages',
  'messages/count_tokens': 'messages',
  'images/generations': 'images',
  'images/edits': 'images',
  'alpha/search': 'search',
  live: 'realtime',
  'realtime/calls': 'realtime',
};

/** Fixed per-call price keys (otherUnitPrices) for operations the core settles with ~zero tokens. */
const FIXED_PRICE_KEYS: Partial<Record<CoreProxyOperation, string>> = {
  'images/generations': 'image_generation',
  'images/edits': 'image_edit',
  'alpha/search': 'web_search_query',
  live: 'realtime_session',
  'realtime/calls': 'realtime_session',
};

/** Operations the core admits/settles itself through the wiolett-core/v1 contract. */
const CORE_ADMITTED: ReadonlySet<CoreProxyOperation> = new Set([
  'responses',
  'responses/compact',
  'chat/completions',
  'messages',
  'images/generations',
  'images/edits',
  'alpha/search',
]);

type ProxyRequestBody = string | ArrayBuffer | FormData;

function requireAuth(c: Context<AppEnv>): { user: User; tokenId: string } {
  const user = c.get('user');
  const auth = c.get('inferenceAuth');
  if (!user || !auth) throw new InferenceProtocolError(401, 'invalid_api_key', 'Authentication required');
  return { user, tokenId: auth.tokenId };
}

/**
 * Transparent data-plane proxy: Gateway keeps authentication, model access,
 * limits, and accounting authority while the managed core owns provider
 * protocols and credentials (plan T5). Client headers never reach the core;
 * the core only sees its data credential and a freshly signed request context.
 */
@injectable()
export class InferenceCoreProxyService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly bridge: InferenceCoreBridgeService,
    private readonly models: InferenceModelService,
    private readonly routing: InferenceRoutingService,
    private readonly coreAccounting: InferenceCoreAccountingService,
    private readonly legacyAccounting: InferenceAccountingService
  ) {}

  /**
   * Resolve the public model to the core-backed source the request will use:
   * access check, candidate filter, and quota-aware connection selection.
   * Shared by the HTTP proxy and the per-turn WebSocket proxy.
   */
  async resolveTarget(
    user: User,
    publicModelId: string,
    options: { affinityKey?: string; existingThread?: boolean; excludeConnectionIds?: string[] } = {}
  ): Promise<{
    model: Awaited<ReturnType<InferenceModelService['resolveForUser']>>['model'];
    selected: SourceCandidate;
    upstreamModel: string;
    coreAccountId: string;
    candidateConnectionIds: string[];
  }> {
    const resolved = await this.models.resolveForUser(user, publicModelId);
    const excluded = new Set(options.excludeConnectionIds ?? []);
    const candidates = (await this.coreCandidates(resolved.model.id, resolved.sources.map((source) => source.id)))
      .filter((candidate) => !excluded.has(candidate.connection.id));
    assertRoutable(candidates);
    const selection = await this.routing.select({
      providerId: candidates[0]!.connection.providerId,
      allowedConnectionIds: candidates.map((row) => row.connection.id),
      ...(options.affinityKey ? { affinityKey: options.affinityKey } : {}),
      existingThread: options.existingThread === true,
    });
    const selected = candidates.find((row) => row.connection.id === selection.connectionId);
    if (!selected || !selected.source.coreAccountId || !selected.source.coreModelId) {
      throw new InferenceProtocolError(503, 'service_unavailable', 'The selected model source is not core-backed');
    }
    return {
      model: resolved.model,
      selected,
      upstreamModel: selected.source.coreModelId,
      coreAccountId: exactCoreAccountId(selected),
      candidateConnectionIds: candidates.map((candidate) => candidate.connection.id),
    };
  }

  /** Core base URL + data credential as a stable Gateway error when unavailable. */
  async dataPlaneTarget(): Promise<{ baseUrl: string; credential: string }> {
    return this.coreTarget();
  }

  async proxy(c: Context<AppEnv>, operation: CoreProxyOperation): Promise<Response> {
    const { user, tokenId } = requireAuth(c);
    const prepared = await this.prepareBody(c, operation);
    let resolved = await this.resolveTarget(
      user,
      prepared.publicModelId,
      {
        ...(prepared.affinityKey ? { affinityKey: prepared.affinityKey } : {}),
        existingThread: prepared.existingThread,
      }
    );
    // Realtime is not admitted by the core; it keeps the legacy fixed-charge
    // accounting at the Gateway edge. Everything else correlates through the
    // request row the core's admission callback references.
    if (OPERATION_PROTOCOL[operation] === 'realtime') {
      const body = prepared.rewrite(resolved.upstreamModel, resolved.model, resolved.selected.source);
      return this.proxyRealtime(
        c,
        operation,
        user.id,
        tokenId,
        resolved.model,
        resolved.selected,
        resolved.upstreamModel,
        body
      );
    }

    const coreAdmitted = CORE_ADMITTED.has(operation);
    // Resolve the managed core before creating an idempotent root row. A
    // missing/degraded core must not leave an unserviceable reserved request.
    const target = await this.coreTarget();
    let rootRequestId: string = randomUUID();
    let fixedApiMicrodollars = 0;
    if (coreAdmitted) {
      fixedApiMicrodollars = await this.fixedCharge(operation, resolved.selected.source.id, prepared.units);
      rootRequestId = (
        await this.coreAccounting.createCoreRequest({
          userId: user.id,
          tokenId,
          protocol: OPERATION_PROTOCOL[operation],
          operation: requestOperation(operation),
          model: resolved.model,
          source: resolved.selected.source,
          connection: resolved.selected.connection,
          serviceTier: prepared.serviceTier ?? null,
          reasoningEffort: prepared.reasoningEffort ?? null,
          ...(prepared.idempotencyKey ? { idempotencyKey: prepared.idempotencyKey } : {}),
          ...(prepared.affinityKey ? { affinityKey: prepared.affinityKey } : {}),
          ...(fixedApiMicrodollars ? { fixedApiMicrodollars } : {}),
          ...(operation === 'responses/compact' ? { isCompaction: true } : {}),
        })
      ).requestId;
    }
    const excludedConnectionIds: string[] = [];
    try {
      for (;;) {
        if (excludedConnectionIds.length > 0) {
          resolved = await this.resolveTarget(user, prepared.publicModelId, {
            ...(prepared.affinityKey ? { affinityKey: prepared.affinityKey } : {}),
            existingThread: prepared.existingThread,
            excludeConnectionIds: excludedConnectionIds,
          });
          if (coreAdmitted) {
            fixedApiMicrodollars = await this.fixedCharge(operation, resolved.selected.source.id, prepared.units);
            await this.coreAccounting.retargetCoreRequest(
              rootRequestId,
              resolved.selected.source,
              resolved.selected.connection,
              fixedApiMicrodollars
            );
          }
        }
        const body = prepared.rewrite(resolved.upstreamModel, resolved.model, resolved.selected.source);
        const { claims } = newCoreRequestContext({
          tenantUserId: user.id,
          rootRequestId,
          publicModelId: resolved.model.publicId,
          coreAccountId: resolved.coreAccountId,
          coreModelId: resolved.upstreamModel,
          operation: contextOperation(operation),
        });
        const allowFailover = coreAdmitted && resolved.candidateConnectionIds.length > 1;
        const forwarded = await this.forward(
          c,
          target,
          claims,
          rootRequestId,
          coreAdmitted,
          `/v1/${operation}`,
          { method: 'POST', headers: prepared.headers, body },
          allowFailover
        );
        if (forwarded.kind === 'response') return forwarded.response;
        excludedConnectionIds.push(resolved.selected.connection.id);
      }
    } catch (error) {
      if (coreAdmitted) {
        const cancelled = c.req.raw.signal.aborted || (error instanceof InferenceProtocolError && error.status === 499);
        await this.coreAccounting
          .finalizeCoreRequest(rootRequestId, cancelled ? 'cancelled' : 'failed', error)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  /** Core base URL + data credential, mapped to a stable Gateway error when unavailable. */
  private async coreTarget(): Promise<{ baseUrl: string; credential: string }> {
    try {
      return await this.bridge.dataPlaneTarget();
    } catch {
      throw new InferenceProtocolError(503, 'inference_core_unavailable', 'The inference core is unavailable');
    }
  }

  private async forward(
    c: Context<AppEnv>,
    target: { baseUrl: string; credential: string },
    claims: Parameters<typeof coreRequestHeaders>[0],
    requestId: string,
    accounted: boolean,
    path: string,
    init: { method: string; headers: Record<string, string>; body: ProxyRequestBody },
    allowFailover = false
  ): Promise<{ kind: 'response'; response: Response } | { kind: 'retry' }> {
    const controller = new AbortController();
    let clientGone = false;
    if (c.req.raw.signal.aborted) controller.abort(c.req.raw.signal.reason);
    else {
      c.req.raw.signal.addEventListener(
        'abort',
        () => {
          clientGone = true;
          controller.abort(c.req.raw.signal.reason);
        },
        { once: true }
      );
    }
    const finalize = once((outcome: 'completed' | 'failed' | 'cancelled', error?: unknown) => {
      if (!accounted) return;
      void this.coreAccounting.finalizeCoreRequest(requestId, outcome, error).catch(() => undefined);
    });

    let upstream: Response;
    try {
      upstream = await fetch(`${target.baseUrl}${path}`, {
        method: init.method,
        headers: { ...init.headers, ...coreRequestHeaders(claims, target.credential) },
        body: init.body,
        signal: controller.signal,
        duplex: 'half',
      });
    } catch (error) {
      if (allowFailover && !clientGone) return { kind: 'retry' };
      finalize(clientGone ? 'cancelled' : 'failed', error);
      if (clientGone) throw new InferenceProtocolError(499, 'client_cancelled', 'Client disconnected');
      throw new InferenceProtocolError(503, 'inference_core_unavailable', 'The inference core is unavailable');
    }
    const status = upstream.status;
    if (allowFailover && (await shouldFailOverCoreResponse(upstream))) {
      await upstream.body?.cancel().catch(() => undefined);
      return { kind: 'retry' };
    }
    if (!upstream.body) {
      finalize(status < 400 ? 'completed' : 'failed');
      return {
        kind: 'response',
        response: new Response(null, { status, headers: publicResponseHeaders(upstream.headers) }),
      };
    }
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    upstream.body.pipeTo(stream.writable).then(
      () => finalize(status < 400 ? 'completed' : 'failed'),
      (error) => finalize(clientGone ? 'cancelled' : 'failed', error)
    );
    return {
      kind: 'response',
      response: new Response(stream.readable, { status, headers: publicResponseHeaders(upstream.headers) }),
    };
  }

  // -------------------------------------------------------------- realtime
  // The core does not admit realtime calls; keep the legacy fixed session
  // charge at the Gateway edge and release it when the upstream call ends.

  private async proxyRealtime(
    c: Context<AppEnv>,
    operation: CoreProxyOperation,
    userId: string,
    tokenId: string,
    model: Parameters<InferenceAccountingService['admitExtended']>[0]['model'],
    selected: SourceCandidate,
    upstreamModel: string,
    body: ProxyRequestBody
  ): Promise<Response> {
    const admission = await this.legacyAccounting.admitExtended({
      userId,
      tokenId,
      protocol: 'realtime',
      operation: 'realtime_call',
      model,
      source: selected.source,
      connection: selected.connection,
      priceKey: FIXED_PRICE_KEYS[operation]!,
      units: 1,
    });
    const target = await this.coreTarget();
    const { claims } = newCoreRequestContext({
      tenantUserId: userId,
      rootRequestId: admission.requestId,
      publicModelId: model.publicId,
      coreAccountId: exactCoreAccountId(selected),
      coreModelId: upstreamModel,
      operation: 'realtime/calls',
    });
    try {
      await this.legacyAccounting.markDispatched(admission);
      const query = `?model=${encodeURIComponent(upstreamModel)}`;
      const upstream = await fetch(`${target.baseUrl}/v1/${operation === 'live' ? 'live' : 'realtime/calls'}${query}`, {
        method: 'POST',
        headers: {
          'content-type': c.req.header('Content-Type') ?? 'application/sdp',
          'x-inference-model': upstreamModel,
          ...coreRequestHeaders(claims, target.credential),
        },
        body,
        signal: c.req.raw.signal,
        duplex: 'half',
      });
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      const piped = upstream.body ? upstream.body.pipeTo(stream.writable) : null;
      piped?.then(
        () => void this.legacyAccounting.settle(admission, zeroUsage(), true).catch(() => undefined),
        () => void this.legacyAccounting.settle(admission, zeroUsage(), true).catch(() => undefined)
      );
      if (!piped) await this.legacyAccounting.settle(admission, zeroUsage(), true);
      return new Response(piped ? stream.readable : null, {
        status: upstream.status,
        headers: publicResponseHeaders(upstream.headers),
      });
    } catch (error) {
      await this.legacyAccounting.fail(admission, error, false);
      if (error instanceof InferenceProtocolError) throw error;
      throw new InferenceProtocolError(503, 'inference_core_unavailable', 'The inference core is unavailable');
    }
  }

  // ----------------------------------------------------------- preparation

  private async prepareBody(c: Context<AppEnv>, operation: CoreProxyOperation): Promise<{
    publicModelId: string;
    units: number;
    headers: Record<string, string>;
    serviceTier?: string;
    reasoningEffort?: string;
    idempotencyKey?: string;
    affinityKey?: string;
    existingThread: boolean;
    rewrite: (
      upstreamModel: string,
      model: { reasoningEfforts: string[]; defaultReasoningEffort: string | null },
      source: SourceCandidate['source']
    ) => ProxyRequestBody;
  }> {
    if (operation === 'images/edits') {
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        throw new InferenceProtocolError(400, 'invalid_request_error', 'Image edits require multipart form data');
      }
      const model = requiredModel(form.get('model'));
      const units = positiveUnits(Number(form.get('n') ?? 1));
      return {
        publicModelId: model,
        units,
        headers: {},
        existingThread: false,
        rewrite: (upstreamModel) => {
          const upstream = new FormData();
          for (const [key, value] of form.entries()) upstream.append(key, value);
          upstream.set('model', upstreamModel);
          return upstream;
        },
      };
    }
    if (operation === 'live' || operation === 'realtime/calls') {
      const rawBody = await c.req.arrayBuffer();
      const model = requiredModel(c.req.query('model') ?? c.req.header('x-inference-model'));
      return {
        publicModelId: model,
        units: 1,
        headers: {}, // realtime builds its own headers in proxyRealtime
        existingThread: false,
        rewrite: () => rawBody,
      };
    }
    let body: Record<string, unknown>;
    try {
      const value = await c.req.json();
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      body = value as Record<string, unknown>;
    } catch {
      throw new InferenceProtocolError(400, 'invalid_request_error', 'Request body must be a JSON object');
    }
    const model = requiredModel(body.model);
    const units = operation === 'images/generations' ? positiveUnits(Number(body.n ?? 1)) : 1;
    const reasoningEffort =
      (body.reasoning && typeof body.reasoning === 'object'
        ? (body.reasoning as Record<string, unknown>).effort
        : undefined) ?? body.reasoning_effort;
    return {
      publicModelId: model,
      units,
      headers: { 'content-type': 'application/json' },
      ...(typeof body.service_tier === 'string' ? { serviceTier: body.service_tier } : {}),
      ...(typeof reasoningEffort === 'string' ? { reasoningEffort } : {}),
      ...(typeof body.idempotency_key === 'string' ? { idempotencyKey: body.idempotency_key } : {}),
      ...(typeof body.prompt_cache_key === 'string' ? { affinityKey: body.prompt_cache_key } : {}),
      existingThread: typeof body.previous_response_id === 'string',
      rewrite: (upstreamModel, resolvedModel, source) => {
        const next: Record<string, unknown> = { ...body, model: upstreamModel };
        const mapped = mapReasoningEffort(
          typeof reasoningEffort === 'string' ? reasoningEffort : undefined,
          resolvedModel.defaultReasoningEffort,
          resolvedModel.reasoningEfforts,
          source.reasoningEffortMap
        );
        if (mapped.upstreamEffort) {
          if (body.reasoning && typeof body.reasoning === 'object') {
            next.reasoning = { ...(body.reasoning as Record<string, unknown>), effort: mapped.upstreamEffort };
          } else if (typeof body.reasoning_effort === 'string') {
            next.reasoning_effort = mapped.upstreamEffort;
          } else if (operation === 'responses' || operation === 'responses/compact') {
            next.reasoning = { effort: mapped.upstreamEffort };
          } else {
            next.reasoning_effort = mapped.upstreamEffort;
          }
        }
        return JSON.stringify(next);
      },
    };
  }

  /** Core-backed, enabled, operation-capable sources joined with their connections. */
  private async coreCandidates(modelId: string, allowedSourceIds: string[]): Promise<SourceCandidate[]> {
    if (!allowedSourceIds.length) return [];
    return this.db
      .select({ source: inferenceModelSources, connection: inferenceProviderConnections })
      .from(inferenceModelSources)
      .innerJoin(inferenceProviderConnections, eq(inferenceModelSources.connectionId, inferenceProviderConnections.id))
      .leftJoin(inferenceDiscoveredModels, eq(inferenceModelSources.discoveredModelId, inferenceDiscoveredModels.id))
      .where(
        and(
          eq(inferenceModelSources.modelId, modelId),
          inArray(inferenceModelSources.id, allowedSourceIds),
          eq(inferenceModelSources.enabled, true),
          isNotNull(inferenceModelSources.coreAccountId),
          eq(inferenceProviderConnections.enabled, true),
          isNull(inferenceProviderConnections.deletedAt),
          or(isNull(inferenceModelSources.discoveredModelId), eq(inferenceDiscoveredModels.available, true))
        )
      )
      .orderBy(asc(inferenceModelSources.priority), asc(inferenceProviderConnections.routingOrder));
  }

  /** Fixed per-call charge for operations the core settles without token usage. */
  private async fixedCharge(operation: CoreProxyOperation, sourceId: string, units: number): Promise<number> {
    const priceKey = FIXED_PRICE_KEYS[operation];
    if (!priceKey) return 0;
    const pricing = await this.db.query.inferencePricingSnapshots.findFirst({
      where: eq(inferencePricingSnapshots.sourceId, sourceId),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    });
    const amount = unitCharge(pricing ?? null, priceKey, units);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new InferenceProtocolError(503, 'pricing_unavailable', `API pricing for ${priceKey} is unavailable`);
    }
    return amount;
  }
}

function exactCoreAccountId(selected: SourceCandidate): string {
  const metadataAccountId = selected.connection.metadata?.[CORE_ACCOUNT_METADATA_KEY];
  if (selected.connection.authType === 'oauth') {
    if (typeof metadataAccountId !== 'string' || !metadataAccountId) {
      throw new InferenceProtocolError(503, 'core_account_unavailable', 'The selected OAuth account is not linked to the core');
    }
    return metadataAccountId;
  }
  if (!selected.source.coreAccountId) {
    throw new InferenceProtocolError(503, 'core_account_unavailable', 'The selected account is not linked to the core');
  }
  return selected.source.coreAccountId;
}

export async function shouldFailOverCoreResponse(response: Response): Promise<boolean> {
  if (![401, 408, 409, 429, 502, 503, 504].includes(response.status)) return false;
  let code = 'provider_unavailable';
  try {
    const body = (await response.clone().json()) as {
      code?: unknown;
      error?: { code?: unknown; type?: unknown };
    };
    const candidate = body.error?.code ?? body.error?.type ?? body.code;
    if (typeof candidate === 'string' && candidate) code = candidate;
  } catch {
    // Status remains sufficient for transport/upstream failures with a non-JSON body.
  }
  const protocolStatus = response.status === 408 || response.status === 504 ? 503 : response.status;
  return canFailOver(
    new InferenceProtocolError(
      protocolStatus as 401 | 409 | 429 | 502 | 503,
      code,
      'The selected provider attempt failed'
    ),
    false
  );
}

function contextOperation(operation: CoreProxyOperation): string {
  switch (operation) {
    case 'chat/completions':
      return 'chat_completions';
    case 'messages':
    case 'messages/count_tokens':
      return 'messages';
    case 'images/generations':
    case 'images/edits':
      return 'images';
    case 'alpha/search':
      return 'search';
    default:
      return operation;
  }
}

function requestOperation(operation: CoreProxyOperation): string {
  switch (operation) {
    case 'images/generations':
      return 'image_generation';
    case 'images/edits':
      return 'image_edit';
    case 'alpha/search':
      return 'search';
    case 'chat/completions':
      return 'chat_completions';
    default:
      return operation;
  }
}

function assertRoutable(candidates: SourceCandidate[]): void {
  const first = candidates[0];
  if (!first) {
    throw new InferenceProtocolError(
      503,
      'service_unavailable',
      'Inference is not configured yet; connect and publish a model first'
    );
  }
  if (candidates.some((row) => row.connection.providerId !== first.connection.providerId)) {
    throw new InferenceProtocolError(
      503,
      'model_configuration_invalid',
      'A logical model must use one provider and one upstream model'
    );
  }
}

function requiredModel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InferenceProtocolError(400, 'invalid_request_error', 'model is required');
  }
  return value.trim();
}

function positiveUnits(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new InferenceProtocolError(400, 'invalid_request_error', 'n must be an integer between 1 and 100');
  }
  return value;
}

function publicResponseHeaders(headers: Headers): Headers {
  const output = new Headers({ 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  for (const name of ['content-type', 'content-disposition']) {
    const value = headers.get(name);
    if (value) output.set(name, value);
  }
  return output;
}

function zeroUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    estimated: false,
  };
}

function once(fn: (outcome: 'completed' | 'failed' | 'cancelled', error?: unknown) => void) {
  let called = false;
  return (outcome: 'completed' | 'failed' | 'cancelled', error?: unknown) => {
    if (called) return;
    called = true;
    fn(outcome, error);
  };
}

export const __testOnly = {
  contextOperation,
  requestOperation,
  assertRoutable,
  publicResponseHeaders,
  shouldFailOverCoreResponse,
};
