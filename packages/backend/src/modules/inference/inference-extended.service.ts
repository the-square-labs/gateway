import { and, asc, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { inferenceModelSources, inferenceProviderConnections } from '@/db/schema/index.js';
import type { AppEnv, User } from '@/types.js';
import type { InferenceAccountingService, InferenceAdmission } from './accounting/inference-accounting.service.js';
import type { InferenceModelService } from './models/inference-model.service.js';
import { InferenceProtocolError } from './protocol/inference-protocol.error.js';
import type { InferenceDestinationPolicy } from './providers/inference-destination-policy.js';
import type { InferenceProviderRegistry } from './providers/inference-provider.registry.js';
import type { InferenceProviderCredentialService } from './providers/inference-provider-credential.service.js';
import type { InferenceProviderHttpConnector } from './providers/inference-provider-http.connector.js';
import type { InferenceRoutingService } from './providers/inference-routing.service.js';

type ExtendedOperation = 'images' | 'realtime';
type SourceRow = {
  source: typeof inferenceModelSources.$inferSelect;
  connection: typeof inferenceProviderConnections.$inferSelect;
};

@injectable()
export class InferenceExtendedService {
  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly models: InferenceModelService,
    private readonly accounting: InferenceAccountingService,
    private readonly credentials: InferenceProviderCredentialService,
    private readonly registry: InferenceProviderRegistry,
    private readonly connector: InferenceProviderHttpConnector,
    private readonly destinations: InferenceDestinationPolicy,
    private readonly routing: InferenceRoutingService
  ) {}

  async imageGenerations(c: Context<AppEnv>): Promise<Response> {
    const body = await jsonObject(c);
    const model = requiredModel(body.model);
    const units = positiveUnits(body.n);
    return this.proxy(c, {
      model,
      operation: 'images',
      operationName: 'image_generation',
      priceKey: 'image_generation',
      units,
      path: () => '/images/generations',
      request: (upstreamModel) => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, model: upstreamModel }),
        signal: c.req.raw.signal,
      }),
    });
  }

  async imageEdits(c: Context<AppEnv>): Promise<Response> {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw new InferenceProtocolError(400, 'invalid_request_error', 'Image edits require multipart form data');
    }
    const model = requiredModel(form.get('model'));
    const units = positiveUnits(Number(form.get('n') ?? 1));
    return this.proxy(c, {
      model,
      operation: 'images',
      operationName: 'image_edit',
      priceKey: 'image_edit',
      units,
      path: () => '/images/edits',
      request: (upstreamModel) => {
        const upstream = new FormData();
        for (const [key, value] of form.entries()) upstream.append(key, value);
        upstream.set('model', upstreamModel);
        return { method: 'POST', body: upstream, signal: c.req.raw.signal };
      },
    });
  }

  async realtimeCall(c: Context<AppEnv>): Promise<Response> {
    const contentType = c.req.header('Content-Type') ?? 'application/sdp';
    const rawBody = await c.req.arrayBuffer();
    const model = requiredModel(c.req.query('model') ?? c.req.header('x-inference-model'));
    return this.proxy(c, {
      model,
      operation: 'realtime',
      operationName: 'realtime_call',
      priceKey: 'realtime_session',
      units: 1,
      path: (upstreamModel) => `/realtime/calls?model=${encodeURIComponent(upstreamModel)}`,
      request: (upstreamModel) => ({
        method: 'POST',
        headers: { 'Content-Type': contentType, 'x-inference-model': upstreamModel },
        body: rawBody,
        signal: c.req.raw.signal,
      }),
    });
  }

  private async proxy(
    c: Context<AppEnv>,
    input: {
      model: string;
      operation: ExtendedOperation;
      operationName: string;
      priceKey: string;
      units: number;
      path: (upstreamModel: string) => string;
      request: (upstreamModel: string) => RequestInit;
    }
  ): Promise<Response> {
    const { user, tokenId } = requireAuth(c);
    const resolved = await this.models.resolveForUser(user, input.model);
    const sources = await this.sources(resolved.model.id, input.operation);
    if (sources.length === 0) {
      throw new InferenceProtocolError(503, 'operation_unavailable', `No API source supports ${input.operation}`);
    }
    assertSingleProviderModel(sources);
    let lastError: unknown;
    const attempted = new Set<string>();
    for (let attempt = 0; attempt < sources.length; attempt += 1) {
      let admission: InferenceAdmission | null = null;
      const remaining = sources.filter((row) => !attempted.has(row.connection.id));
      if (!remaining.length) break;
      const selection = await this.routing.select({
        providerId: remaining[0]!.connection.providerId,
        allowedConnectionIds: remaining.map((row) => row.connection.id),
        existingThread: false,
      });
      const row = remaining.find((candidate) => candidate.connection.id === selection.connectionId);
      if (!row) break;
      attempted.add(row.connection.id);
      try {
        admission = await this.accounting.admitExtended({
          userId: user.id,
          tokenId,
          protocol: input.operation,
          operation: input.operationName,
          model: resolved.model,
          source: row.source,
          connection: row.connection,
          priceKey: input.priceKey,
          units: input.units,
        });
        await this.destinations.assertAllowed(
          row.connection.baseUrl,
          row.connection.metadata.allowPrivateNetwork === true
        );
        const definition = this.registry.require(row.connection.providerId);
        const credential = await this.credentials.get(row.connection.id);
        await this.accounting.markDispatched(admission);
        const response = await this.connector.rawRequest(
          definition,
          credential,
          row.connection.baseUrl,
          input.path(row.source.upstreamModelId),
          input.request(row.source.upstreamModelId),
          row.connection.metadata.allowPrivateNetwork === true
        );
        if (!response.ok) throw providerFailure(response.status);
        await this.accounting.settle(admission, emptyUsage(), true);
        return new Response(response.body, {
          status: response.status,
          headers: publicResponseHeaders(response.headers),
        });
      } catch (error) {
        lastError = error;
        if (admission) await this.accounting.fail(admission, error, false);
        if (!(error instanceof InferenceProtocolError) || ![429, 502, 503].includes(error.status)) throw error;
        if (error.code === 'provider_rate_limited') {
          await this.routing.markCooldown(row.connection.id, 30, 'Provider rate limited');
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new InferenceProtocolError(502, 'provider_unavailable', 'Provider failed');
  }

  private async sources(modelId: string, operation: ExtendedOperation): Promise<SourceRow[]> {
    const rows = await this.db
      .select({ source: inferenceModelSources, connection: inferenceProviderConnections })
      .from(inferenceModelSources)
      .innerJoin(inferenceProviderConnections, eq(inferenceModelSources.connectionId, inferenceProviderConnections.id))
      .where(
        and(
          eq(inferenceModelSources.modelId, modelId),
          eq(inferenceModelSources.sourceType, 'api'),
          eq(inferenceModelSources.enabled, true),
          eq(inferenceProviderConnections.enabled, true)
        )
      )
      .orderBy(asc(inferenceModelSources.priority), asc(inferenceProviderConnections.routingOrder));
    return rows.filter((row) =>
      (this.registry.require(row.connection.providerId).supportedOperations ?? ['inference']).includes(operation)
    );
  }
}

function assertSingleProviderModel(rows: SourceRow[]): void {
  const first = rows[0];
  if (!first) return;
  if (
    rows.some(
      (row) =>
        row.connection.providerId !== first.connection.providerId ||
        row.source.upstreamModelId !== first.source.upstreamModelId
    )
  ) {
    throw new InferenceProtocolError(
      503,
      'model_configuration_invalid',
      'A logical model must use one provider and one upstream model'
    );
  }
}

async function jsonObject(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  try {
    const value = await c.req.json();
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Normalized below.
  }
  throw new InferenceProtocolError(400, 'invalid_request_error', 'Request body must be a JSON object');
}

function requireAuth(c: Context<AppEnv>): { user: User; tokenId: string } {
  const user = c.get('user');
  const auth = c.get('inferenceAuth');
  if (!user || !auth) throw new InferenceProtocolError(401, 'invalid_api_key', 'Authentication required');
  return { user, tokenId: auth.tokenId };
}

function requiredModel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InferenceProtocolError(400, 'invalid_request_error', 'model is required');
  }
  return value.trim();
}

function positiveUnits(value: unknown): number {
  const units = value === undefined ? 1 : Number(value);
  if (!Number.isInteger(units) || units < 1 || units > 100) {
    throw new InferenceProtocolError(400, 'invalid_request_error', 'n must be an integer between 1 and 100');
  }
  return units;
}

function providerFailure(status: number): InferenceProtocolError {
  if (status === 401 || status === 403) {
    return new InferenceProtocolError(502, 'provider_reauth_required', 'Provider credential needs reauthentication');
  }
  if (status === 429) return new InferenceProtocolError(429, 'provider_rate_limited', 'Provider is rate limited');
  return new InferenceProtocolError(502, 'provider_request_failed', `Provider request failed with HTTP ${status}`);
}

function publicResponseHeaders(headers: Headers): Headers {
  const output = new Headers({ 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  for (const name of ['content-type', 'content-disposition']) {
    const value = headers.get(name);
    if (value) output.set(name, value);
  }
  return output;
}

function emptyUsage() {
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

export const __testOnly = {
  requiredModel,
  positiveUnits,
  providerFailure,
  publicResponseHeaders,
  emptyUsage,
  assertSingleProviderModel,
};
