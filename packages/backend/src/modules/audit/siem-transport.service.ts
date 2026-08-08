import { createHmac } from 'node:crypto';
import type { Env } from '@/config/env.js';
import type { SiemAuditEvent, siemDestinations } from '@/db/schema/siem.js';
import { AppError } from '@/middleware/error-handler.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import {
  checkOutboundWebhookTarget,
  type OutboundWebhookPolicyService,
} from '@/modules/settings/outbound-webhook-policy.service.js';
import { fetchWithPinnedAddresses } from '@/modules/settings/outbound-webhook-request.js';
import type { CryptoService } from '@/services/crypto.service.js';
import { SiemCustomHeaderNameSchema, SiemEndpointUrlSchema } from './siem.schemas.js';

const HTTP_TIMEOUT_MS = 10_000;

export interface SiemTestEvent {
  id: string;
  source: string;
  type: 'com.wiolett.gateway.audit.test.v1';
  time: string;
  test: true;
  data: SiemAuditEvent['data'];
}

export type SiemEvent = SiemAuditEvent | SiemTestEvent;

export interface SiemTransportResult {
  success: boolean;
  statusCode?: number;
  responseTimeMs: number;
  error?: string;
}

type SiemDestinationTransportConfig = Pick<
  typeof siemDestinations.$inferSelect,
  'url' | 'authType' | 'customHeaderName' | 'encryptedSecret'
>;

/**
 * A small security boundary shared by config validation and delivery. It keeps
 * SIEM destinations inside the outbound-webhook network policy, preserves
 * validated DNS addresses, and intentionally never follows redirects.
 */
export class SiemTransportService {
  constructor(
    private readonly env: Env,
    private readonly cryptoService: CryptoService,
    private readonly outboundWebhookPolicyService: OutboundWebhookPolicyService,
    private readonly generalSettingsService?: GeneralSettingsService
  ) {}

  async validateEndpoint(url: string): Promise<void> {
    const parsed = SiemEndpointUrlSchema.safeParse(url);
    if (!parsed.success) {
      throw new AppError(400, 'SIEM_ENDPOINT_INVALID', parsed.error.issues[0]?.message ?? 'SIEM endpoint is invalid');
    }
    const policy = await this.outboundWebhookPolicyService.getConfig();
    const result = await checkOutboundWebhookTarget(
      parsed.data,
      policy,
      this.env,
      this.generalSettingsService?.getCachedPublicUrl()
    );
    if (!result.allowed) {
      throw new AppError(400, 'SIEM_ENDPOINT_BLOCKED', 'SIEM destination is blocked by the outbound network policy');
    }
  }

  async send(destination: SiemDestinationTransportConfig, events: SiemEvent[]): Promise<SiemTransportResult> {
    const startTime = Date.now();
    let statusCode: number | undefined;
    let error: string | undefined;
    const body = JSON.stringify({ schemaVersion: 1, events });
    const timestamp = new Date().toISOString();

    try {
      const parsed = SiemEndpointUrlSchema.safeParse(destination.url);
      if (!parsed.success) throw new Error('SIEM destination has an invalid endpoint');

      const policy = await this.outboundWebhookPolicyService.getConfig();
      const target = await checkOutboundWebhookTarget(
        parsed.data,
        policy,
        this.env,
        this.generalSettingsService?.getCachedPublicUrl()
      );
      if (!target.allowed || target.resolvedAddresses.length === 0) {
        throw new Error(
          `SIEM destination blocked by outbound network policy: ${target.reason ?? 'target is not allowed'}`
        );
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Gateway-Schema-Version': '1',
        'X-Gateway-Timestamp': timestamp,
        'User-Agent': 'Wiolett-Gateway-SIEM/1',
      };
      const secret = this.decryptSecret(destination.encryptedSecret);
      if (destination.authType === 'bearer') {
        headers.Authorization = `Bearer ${secret}`;
      } else if (destination.authType === 'hmac_sha256') {
        headers['X-Gateway-Signature-256'] = `sha256=${createHmac('sha256', secret)
          .update(`${timestamp}.${body}`)
          .digest('hex')}`;
      } else {
        const customHeaderName = SiemCustomHeaderNameSchema.safeParse(destination.customHeaderName);
        if (!customHeaderName.success) throw new Error('SIEM destination has an invalid custom header name');
        headers[customHeaderName.data] = secret;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
      try {
        const response = await fetchWithPinnedAddresses(parsed.data, target.resolvedAddresses, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });
        statusCode = response.status;
        // Consume the bounded body to release the socket, but never persist or
        // surface it: collector responses may contain sensitive diagnostics.
        await response.text().catch(() => '');
      } finally {
        clearTimeout(timeout);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      error = message.includes('aborted') ? `Request timed out after ${HTTP_TIMEOUT_MS}ms` : sanitizeError(message);
    }

    return {
      success: statusCode !== undefined && statusCode >= 200 && statusCode < 300,
      statusCode,
      responseTimeMs: Date.now() - startTime,
      error,
    };
  }

  private decryptSecret(encryptedSecret: string): string {
    try {
      return this.cryptoService.decryptString(JSON.parse(encryptedSecret));
    } catch {
      throw new Error('SIEM destination secret cannot be decrypted');
    }
  }
}

function sanitizeError(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 512);
}
