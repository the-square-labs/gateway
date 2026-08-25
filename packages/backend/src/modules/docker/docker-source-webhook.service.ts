import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { getEnv } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import { dockerSourceBindings, dockerSourceWebhookDeliveries, integrationConnectors } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import { DockerBuildCommitShaSchema } from './docker-build.schemas.js';
import type { DockerBuildService } from './docker-build.service.js';
import type { SourceBindingRow, SupportedSourceProvider } from './docker-source-mappers.js';

export interface DockerSourceWebhookResult {
  accepted: boolean;
  duplicate: boolean;
  sourceBindingId: string;
  provider: SupportedSourceProvider;
  deliveryId: string;
  commitSha: string;
  branch: string;
  autoBuild: boolean;
  autoDeploy: boolean;
}

function exactSecretMatch(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function exactSignatureMatch(actual: string | undefined, expectedHex: string): boolean {
  if (!actual?.startsWith('sha256=')) return false;
  const provided = actual.slice('sha256='.length);
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;
  const actualBuffer = Buffer.from(provided, 'hex');
  const expectedBuffer = Buffer.from(expectedHex, 'hex');
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export class DockerSourceWebhookService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly integrations: IntegrationsService,
    private readonly cryptoService: CryptoService,
    private readonly getBuildService: () => DockerBuildService | undefined
  ) {}

  webhookSecret(sourceBindingId: string): string {
    return this.cryptoService.deriveScopedSecret(`docker-source-webhook:v1:${sourceBindingId}`);
  }

  async reconcileWebhooks(limit = 50): Promise<{ checked: number; configured: number; failed: number }> {
    const rows = await this.db
      .select()
      .from(dockerSourceBindings)
      .orderBy(asc(dockerSourceBindings.updatedAt), asc(dockerSourceBindings.id))
      .limit(limit);
    let configured = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        if (await this.reconcileWebhook(row)) configured += 1;
      } catch (error) {
        failed += 1;
        await this.db
          .update(dockerSourceBindings)
          .set({ lastWebhookError: (error as Error).message.slice(0, 2048), updatedAt: new Date() })
          .where(eq(dockerSourceBindings.id, row.id));
      }
    }
    return { checked: rows.length, configured, failed };
  }

  async reconcileWebhook(binding: SourceBindingRow): Promise<boolean> {
    const appUrl = new URL(getEnv().APP_URL);
    if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(appUrl.hostname)) {
      await this.db
        .update(dockerSourceBindings)
        .set({
          webhookConfiguredAt: null,
          webhookProviderId: null,
          lastWebhookError: 'Automatic webhook is unavailable for a loopback APP_URL; polling is active',
          updatedAt: new Date(),
        })
        .where(eq(dockerSourceBindings.id, binding.id));
      return false;
    }
    const callbackUrl = new URL(`/api/webhooks/docker-source/${binding.id}`, appUrl).toString();
    const result = await this.integrations.reconcileDockerSourceWebhook({
      connectorId: binding.connectorId,
      projectId: binding.projectId,
      callbackUrl,
      secret: this.webhookSecret(binding.id),
    });
    if (!result) {
      await this.db
        .update(dockerSourceBindings)
        .set({
          webhookConfiguredAt: null,
          webhookProviderId: null,
          lastWebhookError: 'Provider webhook management is unavailable; polling is active',
          updatedAt: new Date(),
        })
        .where(eq(dockerSourceBindings.id, binding.id));
      return false;
    }
    await this.db
      .update(dockerSourceBindings)
      .set({
        webhookConfiguredAt: new Date(),
        webhookProviderId: `${result.provider}:${result.id}`,
        lastWebhookError: null,
        updatedAt: new Date(),
      })
      .where(eq(dockerSourceBindings.id, binding.id));
    return true;
  }

  async handleWebhook(sourceBindingId: string, headers: Headers, rawBody: Buffer): Promise<DockerSourceWebhookResult> {
    const [joined] = await this.db
      .select({ binding: dockerSourceBindings, provider: integrationConnectors.provider })
      .from(dockerSourceBindings)
      .innerJoin(integrationConnectors, eq(integrationConnectors.id, dockerSourceBindings.connectorId))
      .where(eq(dockerSourceBindings.id, sourceBindingId))
      .limit(1);
    if (!joined || !['gitlab', 'github', 'git'].includes(joined.provider)) {
      throw new AppError(404, 'SOURCE_WEBHOOK_NOT_FOUND', 'Source webhook was not found');
    }
    const provider = joined.provider as SupportedSourceProvider;
    this.assertWebhookSignature(provider, headers, rawBody, this.webhookSecret(sourceBindingId));

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new AppError(400, 'SOURCE_WEBHOOK_JSON_INVALID', 'Webhook body must be valid JSON');
    }
    const normalized = this.normalizeWebhook(provider, headers, payload, joined.binding);
    const payloadSha256 = createHash('sha256').update(rawBody).digest('hex');
    const [delivery] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-build-source:${sourceBindingId}`}))`);
      const inserted = await tx
        .insert(dockerSourceWebhookDeliveries)
        .values({
          sourceBindingId,
          provider,
          deliveryId: normalized.deliveryId,
          payloadSha256,
          commitSha: normalized.commitSha,
          accepted: true,
        })
        .onConflictDoNothing({
          target: [dockerSourceWebhookDeliveries.sourceBindingId, dockerSourceWebhookDeliveries.deliveryId],
        })
        .returning();
      if (inserted.length) {
        await tx
          .update(dockerSourceBindings)
          .set({
            desiredCommitSha: normalized.commitSha,
            lastWebhookAt: new Date(),
            lastWebhookError: null,
            updatedAt: new Date(),
          })
          .where(eq(dockerSourceBindings.id, sourceBindingId));
      }
      return inserted;
    });
    if (!delivery) {
      const [current] = await this.db
        .select()
        .from(dockerSourceBindings)
        .where(eq(dockerSourceBindings.id, sourceBindingId))
        .limit(1);
      if (current?.desiredCommitSha?.toLowerCase() === normalized.commitSha.toLowerCase()) {
        await this.enqueueWebhookBuild(current, provider, normalized.deliveryId, normalized.commitSha);
      }
      return this.webhookResult(joined.binding, provider, normalized, true);
    }
    await this.enqueueWebhookBuild(joined.binding, provider, normalized.deliveryId, normalized.commitSha);
    return this.webhookResult(joined.binding, provider, normalized, false);
  }

  private webhookResult(
    binding: SourceBindingRow,
    provider: SupportedSourceProvider,
    normalized: { deliveryId: string; commitSha: string },
    duplicate: boolean
  ): DockerSourceWebhookResult {
    return {
      accepted: true,
      duplicate,
      sourceBindingId: binding.id,
      provider,
      deliveryId: normalized.deliveryId,
      commitSha: normalized.commitSha,
      branch: binding.branch,
      autoBuild: binding.autoBuild,
      autoDeploy: binding.autoDeploy,
    };
  }

  private async enqueueWebhookBuild(
    binding: SourceBindingRow,
    provider: SupportedSourceProvider,
    deliveryId: string,
    commitSha: string
  ): Promise<void> {
    const buildService = this.getBuildService();
    if (!binding.autoBuild || !buildService) return;
    await buildService.enqueue({
      sourceBindingId: binding.id,
      commitSha,
      trigger: provider === 'gitlab' ? 'gitlab_push' : provider === 'github' ? 'github_push' : 'generic_webhook',
      triggerDeliveryId: deliveryId,
    });
  }

  private assertWebhookSignature(
    provider: SupportedSourceProvider,
    headers: Headers,
    rawBody: Buffer,
    secret: string
  ): void {
    if (provider === 'gitlab') {
      if (!exactSecretMatch(headers.get('x-gitlab-token') ?? undefined, secret)) {
        throw new AppError(401, 'SOURCE_WEBHOOK_SIGNATURE_INVALID', 'GitLab webhook signature is invalid');
      }
      return;
    }
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const header = provider === 'github' ? 'x-hub-signature-256' : 'x-gateway-signature-256';
    if (!exactSignatureMatch(headers.get(header) ?? undefined, expected)) {
      throw new AppError(401, 'SOURCE_WEBHOOK_SIGNATURE_INVALID', 'Webhook signature is invalid');
    }
  }

  private normalizeWebhook(
    provider: SupportedSourceProvider,
    headers: Headers,
    rawPayload: unknown,
    binding: SourceBindingRow
  ): { deliveryId: string; commitSha: string } {
    const payload = record(rawPayload);
    const repository = record(payload.repository ?? payload.project);
    const expectedRef = `refs/heads/${binding.branch}`;
    const ref = typeof payload.ref === 'string' ? payload.ref : '';
    const commitCandidate = payload.after ?? record(payload.head_commit).id ?? payload.checkout_sha;
    const commitSha = DockerBuildCommitShaSchema.safeParse(commitCandidate);
    if (ref !== expectedRef) {
      throw new AppError(409, 'SOURCE_WEBHOOK_REF_MISMATCH', 'Webhook ref does not match the configured branch');
    }
    if (!commitSha.success || /^0+$/.test(commitSha.data)) {
      throw new AppError(400, 'SOURCE_WEBHOOK_SHA_INVALID', 'Webhook does not contain a valid commit SHA');
    }

    const remoteId = repository.id === undefined ? '' : String(repository.id);
    const fullPath =
      typeof repository.path_with_namespace === 'string'
        ? repository.path_with_namespace
        : typeof repository.full_name === 'string'
          ? repository.full_name
          : '';
    if (remoteId && remoteId !== binding.repositoryRemoteId) {
      throw new AppError(409, 'SOURCE_WEBHOOK_REPOSITORY_MISMATCH', 'Webhook repository does not match the source');
    }
    if (fullPath && fullPath.toLowerCase() !== binding.repositoryFullPath.toLowerCase()) {
      throw new AppError(409, 'SOURCE_WEBHOOK_REPOSITORY_MISMATCH', 'Webhook repository does not match the source');
    }

    const deliveryHeader =
      provider === 'gitlab'
        ? headers.get('x-gitlab-event-uuid') || headers.get('x-request-id')
        : provider === 'github'
          ? headers.get('x-github-delivery')
          : headers.get('x-gateway-delivery');
    const deliveryId = deliveryHeader?.trim();
    if (!deliveryId || deliveryId.length > 500) {
      throw new AppError(400, 'SOURCE_WEBHOOK_DELIVERY_ID_INVALID', 'Webhook delivery ID is required');
    }
    return { deliveryId, commitSha: commitSha.data.toLowerCase() };
  }
}
