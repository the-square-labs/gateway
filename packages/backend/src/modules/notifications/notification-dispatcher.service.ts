import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { RequestOptions } from 'node:https';
import { request as httpsRequest } from 'node:https';
import { eq } from 'drizzle-orm';
import type { Env } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import { notificationDeliveryLog, notificationWebhooks } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import {
  checkOutboundWebhookTarget,
  type OutboundWebhookPolicyService,
} from '@/modules/settings/outbound-webhook-policy.service.js';
import { buildTemplateContext, type NotificationEvent, renderTemplate } from './notification-templates.js';
import type { NotificationWebhookService } from './notification-webhook.service.js';

const logger = createChildLogger('NotificationDispatcher');

/** Exponential backoff delays in seconds for each retry attempt */
const RETRY_DELAYS = [30, 120, 480, 1800, 7200]; // 30s, 2m, 8m, 30m, 2h
const MAX_RESPONSE_BODY = 2048;
const HTTP_TIMEOUT_MS = 10_000;

interface WebhookFetchOptions {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

interface WebhookFetchResponse {
  status: number;
  text: () => Promise<string>;
}

export class NotificationDispatcherService {
  constructor(
    private db: DrizzleClient,
    private webhookService: NotificationWebhookService,
    private env: Env,
    private outboundWebhookPolicyService: OutboundWebhookPolicyService,
    private generalSettingsService?: GeneralSettingsService
  ) {}

  getGatewayUrl(): string {
    return (
      this.generalSettingsService?.getCachedPublicUrl() ??
      (this.env as Env & { PUBLIC_URL?: string }).PUBLIC_URL ??
      (this.env as Env & { MANAGEMENT_DOMAIN?: string }).MANAGEMENT_DOMAIN ??
      ''
    );
  }

  /**
   * Dispatch a notification event to a single webhook.
   * Renders the template, signs the payload, sends the HTTP request,
   * and logs the delivery attempt.
   *
   * @param isTest - if true, returns result directly instead of scheduling retries
   */
  async dispatch(
    webhook: {
      id: string;
      url: string;
      method: string;
      bodyTemplate: string | null;
      headers: Record<string, string>;
      signingSecret: string | null;
      signingHeader: string | null;
    },
    event: NotificationEvent,
    isTest = false
  ): Promise<{ success: boolean; statusCode?: number; error?: string; rendered?: string }> {
    const context = buildTemplateContext(event, this.getGatewayUrl());

    // Render template
    const body = webhook.bodyTemplate ? renderTemplate(webhook.bodyTemplate, context) : JSON.stringify(context);

    // Build headers
    const headers: Record<string, string> = { ...webhook.headers };

    // Compute HMAC signature if signing secret is set
    if (webhook.signingSecret) {
      const secret = this.webhookService.decryptSigningSecret(webhook.signingSecret);
      if (secret) {
        const headerName = webhook.signingHeader || 'X-Signature-256';
        headers[headerName] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
      }
    }

    // Set Content-Type default if not already set
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }

    // Send HTTP request
    const startTime = Date.now();
    let responseStatus: number | undefined;
    let responseBody: string | undefined;
    let error: string | undefined;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const method = webhook.method || 'POST';
      const fetchOptions: WebhookFetchOptions = {
        method,
        headers,
        signal: controller.signal,
      };

      // Only include body for methods that support it
      if (method !== 'GET') {
        fetchOptions.body = body;
      }

      const response = await this.fetchAllowedWebhookTarget(webhook.url, fetchOptions);

      responseStatus = response.status;
      const rawBody = await response.text().catch(() => '');
      responseBody = rawBody.length > MAX_RESPONSE_BODY ? rawBody.slice(0, MAX_RESPONSE_BODY) : rawBody;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      if (error.includes('abort')) {
        error = `Request timed out after ${HTTP_TIMEOUT_MS}ms`;
      }
    } finally {
      clearTimeout(timeout);
    }

    const responseTimeMs = Date.now() - startTime;
    const success = responseStatus !== undefined && responseStatus >= 200 && responseStatus < 300;

    // Log the delivery attempt
    const status = success ? 'success' : isTest ? 'failed' : 'retrying';
    const nextRetryAt = !success && !isTest ? new Date(Date.now() + RETRY_DELAYS[0] * 1000) : null;

    await this.db.insert(notificationDeliveryLog).values({
      webhookId: webhook.id,
      eventType: event.type,
      severity: event.severity,
      requestUrl: webhook.url,
      requestMethod: webhook.method || 'POST',
      requestBody: body,
      responseStatus: responseStatus ?? null,
      responseBody: responseBody ?? null,
      responseTimeMs,
      attempt: 1,
      maxAttempts: isTest ? 1 : 5,
      nextRetryAt,
      status,
      error: error ?? null,
      completedAt: success ? new Date() : null,
    });

    if (!success) {
      logger.warn('Webhook delivery failed', {
        webhookId: webhook.id,
        url: webhook.url,
        event: event.type,
        status: responseStatus,
        error,
      });
    }

    return { success, statusCode: responseStatus, error, rendered: isTest ? body : undefined };
  }

  /** Retry a failed delivery */
  async retryDelivery(deliveryId: string): Promise<void> {
    const [delivery] = await this.db
      .select()
      .from(notificationDeliveryLog)
      .where(eq(notificationDeliveryLog.id, deliveryId))
      .limit(1);

    if (!delivery || delivery.status !== 'retrying') return;

    // Re-fetch webhook to rebuild headers + HMAC signature
    const [webhook] = await this.db
      .select()
      .from(notificationWebhooks)
      .where(eq(notificationWebhooks.id, delivery.webhookId))
      .limit(1);

    if (!webhook) {
      // Webhook deleted — mark delivery as failed
      await this.db
        .update(notificationDeliveryLog)
        .set({ status: 'failed', error: 'Webhook no longer exists', completedAt: new Date() })
        .where(eq(notificationDeliveryLog.id, deliveryId));
      return;
    }

    const nextAttempt = delivery.attempt + 1;

    // Rebuild headers from webhook config
    const retryHeaders: Record<string, string> = { ...((webhook.headers as Record<string, string>) ?? {}) };
    if (webhook.signingSecret && delivery.requestBody) {
      const secret = this.webhookService.decryptSigningSecret(webhook.signingSecret);
      if (secret) {
        const headerName = webhook.signingHeader || 'X-Signature-256';
        retryHeaders[headerName] = `sha256=${createHmac('sha256', secret).update(delivery.requestBody).digest('hex')}`;
      }
    }
    if (!Object.keys(retryHeaders).some((k) => k.toLowerCase() === 'content-type')) {
      retryHeaders['Content-Type'] = 'application/json';
    }

    const startTime = Date.now();
    let responseStatus: number | undefined;
    let responseBody: string | undefined;
    let error: string | undefined;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const fetchOptions: WebhookFetchOptions = {
        method: delivery.requestMethod,
        headers: retryHeaders,
        signal: controller.signal,
      };

      if (delivery.requestMethod !== 'GET' && delivery.requestBody) {
        fetchOptions.body = delivery.requestBody;
      }

      const response = await this.fetchAllowedWebhookTarget(delivery.requestUrl, fetchOptions);

      responseStatus = response.status;
      const rawBody = await response.text().catch(() => '');
      responseBody = rawBody.length > MAX_RESPONSE_BODY ? rawBody.slice(0, MAX_RESPONSE_BODY) : rawBody;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      if (error.includes('abort')) {
        error = `Request timed out after ${HTTP_TIMEOUT_MS}ms`;
      }
    } finally {
      clearTimeout(timeout);
    }

    const responseTimeMs = Date.now() - startTime;
    const success = responseStatus !== undefined && responseStatus >= 200 && responseStatus < 300;
    const isLastAttempt = nextAttempt >= delivery.maxAttempts;

    let newStatus: string;
    let nextRetryAt: Date | null = null;

    if (success) {
      newStatus = 'success';
    } else if (isLastAttempt) {
      newStatus = 'failed';
    } else {
      newStatus = 'retrying';
      const delayIndex = Math.min(nextAttempt - 1, RETRY_DELAYS.length - 1);
      nextRetryAt = new Date(Date.now() + RETRY_DELAYS[delayIndex] * 1000);
    }

    await this.db
      .update(notificationDeliveryLog)
      .set({
        attempt: nextAttempt,
        responseStatus: responseStatus ?? null,
        responseBody: responseBody ?? null,
        responseTimeMs,
        status: newStatus,
        error: error ?? null,
        nextRetryAt,
        completedAt: success || isLastAttempt ? new Date() : null,
      })
      .where(eq(notificationDeliveryLog.id, deliveryId));

    if (success) {
      logger.info('Webhook retry succeeded', { deliveryId, attempt: nextAttempt });
    } else if (isLastAttempt) {
      logger.warn('Webhook delivery permanently failed', { deliveryId, attempt: nextAttempt, error });
    }
  }

  private async fetchAllowedWebhookTarget(url: string, options: WebhookFetchOptions): Promise<WebhookFetchResponse> {
    const policy = await this.outboundWebhookPolicyService.getConfig();
    const result = await checkOutboundWebhookTarget(
      url,
      policy,
      this.env,
      this.generalSettingsService?.getCachedPublicUrl()
    );
    if (!result.allowed) {
      throw new Error(`Webhook target blocked by outbound network policy: ${result.reason ?? 'target is not allowed'}`);
    }
    if (result.resolvedAddresses.length === 0) {
      throw new Error('Webhook target blocked by outbound network policy: target did not resolve');
    }
    return fetchWithPinnedAddresses(url, result.resolvedAddresses, options);
  }
}

async function fetchWithPinnedAddresses(
  rawUrl: string,
  addresses: string[],
  options: WebhookFetchOptions
): Promise<WebhookFetchResponse> {
  let lastError: unknown;
  for (const address of addresses) {
    try {
      return await fetchWithPinnedAddress(rawUrl, address, options);
    } catch (error) {
      if (options.signal.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Webhook request failed for all resolved addresses');
}

export function fetchWithPinnedAddress(
  rawUrl: string,
  address: string,
  options: WebhookFetchOptions
): Promise<WebhookFetchResponse> {
  const url = new URL(rawUrl);
  const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const lookup: NonNullable<RequestOptions['lookup']> = (_hostname, lookupOptions, callback) => {
    const family = address.includes(':') ? 6 : 4;
    const lookupCallback = (typeof lookupOptions === 'function' ? lookupOptions : callback) as (
      err: NodeJS.ErrnoException | null,
      addressOrAddresses: string | Array<{ address: string; family: number }>,
      family?: number
    ) => void;
    const all =
      typeof lookupOptions === 'object' && lookupOptions !== null && 'all' in lookupOptions && lookupOptions.all;

    if (all) {
      lookupCallback(null, [{ address, family }]);
      return;
    }
    lookupCallback(null, address, family);
  };
  const requestOptions: RequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method: options.method,
    headers:
      options.body !== undefined &&
      !Object.keys(options.headers).some((header) => header.toLowerCase() === 'content-length')
        ? { ...options.headers, 'Content-Length': Buffer.byteLength(options.body).toString() }
        : options.headers,
    lookup,
  };

  return new Promise((resolve, reject) => {
    const req = requester(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      let received = 0;
      res.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (received <= MAX_RESPONSE_BODY) {
          chunks.push(buffer.subarray(0, Math.max(0, MAX_RESPONSE_BODY + 1 - received)));
        }
        received += buffer.length;
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode ?? 0,
          text: async () => body,
        });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    if (options.signal.aborted) {
      req.destroy(new Error('Request aborted'));
      return;
    }
    const abort = () => req.destroy(new Error('Request aborted'));
    options.signal.addEventListener('abort', abort, { once: true });
    req.on('close', () => options.signal.removeEventListener('abort', abort));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}
