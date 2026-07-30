import { AppError } from '@/middleware/error-handler.js';
import type { InferenceOAuthCodexDeviceConfig } from './inference-provider.types.js';

type Fetcher = typeof fetch;
type JsonObject = Record<string, unknown>;

export interface CodexDevicePending {
  deviceAuthId: string;
  userCode: string;
}

export async function startCodexDevice(
  oauth: InferenceOAuthCodexDeviceConfig,
  fetcher: Fetcher
): Promise<{ authorizationUrl: string; userCode: string; pollIntervalSeconds: number; pending: CodexDevicePending }> {
  const response = await fetcher(oauth.userCodeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: oauth.clientId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new AppError(502, 'INFERENCE_OAUTH_START_FAILED', `OpenAI device authorization failed (${response.status})`);
  }
  const body = asObject(await response.json());
  const deviceAuthId = stringValue(body?.device_auth_id);
  const userCode = stringValue(body?.user_code) ?? stringValue(body?.usercode);
  const pollIntervalSeconds = Math.max(1, numberValue(body?.interval) ?? 5);
  if (!deviceAuthId || !userCode) {
    throw new AppError(502, 'INFERENCE_OAUTH_INVALID_RESPONSE', 'OpenAI device response is incomplete');
  }
  return {
    authorizationUrl: oauth.verificationUrl,
    userCode,
    pollIntervalSeconds,
    pending: { deviceAuthId, userCode },
  };
}

export async function pollCodexDevice(
  oauth: InferenceOAuthCodexDeviceConfig,
  pending: CodexDevicePending,
  fetcher: Fetcher
): Promise<JsonObject | null> {
  const pollResponse = await fetcher(oauth.deviceTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_auth_id: pending.deviceAuthId, user_code: pending.userCode }),
    signal: AbortSignal.timeout(30_000),
  });
  if (pollResponse.status === 403 || pollResponse.status === 404) return null;
  if (!pollResponse.ok) {
    throw new AppError(
      502,
      'INFERENCE_OAUTH_EXCHANGE_FAILED',
      `OpenAI device authorization failed (${pollResponse.status})`
    );
  }
  const polled = asObject(await pollResponse.json());
  const code = stringValue(polled?.authorization_code);
  const verifier = stringValue(polled?.code_verifier);
  if (!code || !verifier) {
    throw new AppError(502, 'INFERENCE_OAUTH_INVALID_RESPONSE', 'OpenAI device token response is incomplete');
  }
  const tokenResponse = await fetcher(oauth.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: oauth.redirectUri,
      client_id: oauth.clientId,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!tokenResponse.ok) {
    throw new AppError(
      502,
      'INFERENCE_OAUTH_EXCHANGE_FAILED',
      `OpenAI token exchange failed (${tokenResponse.status})`
    );
  }
  return asObject(await tokenResponse.json()) ?? {};
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) ? numeric : undefined;
}
