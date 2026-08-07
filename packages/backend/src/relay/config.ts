import { resolve } from 'node:path';
import { RELAY_VERSION } from './version.js';

export interface RelayConfig {
  port: number;
  appGrpcTarget: string;
  databaseUrl: string;
  identityDir: string;
  relayVersion: string;
  reconcileIntervalMs: number;
  identityPollIntervalMs: number;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function loadRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const databaseUrl = env.RELAY_DATABASE_URL ?? env.GATEWAY_RELAY_DATABASE_URL;
  if (!databaseUrl) throw new Error('RELAY_DATABASE_URL is required');
  return {
    port: positiveInteger(env.RELAY_PORT ?? env.GRPC_PORT, 9443, 'RELAY_PORT'),
    appGrpcTarget: env.RELAY_APP_GRPC_TARGET?.trim() || 'app:9443',
    databaseUrl,
    identityDir: resolve(env.RELAY_IDENTITY_DIR?.trim() || '/var/lib/gateway-relay'),
    relayVersion: env.GATEWAY_RELAY_VERSION?.trim() || RELAY_VERSION,
    reconcileIntervalMs: positiveInteger(env.RELAY_RECONCILE_INTERVAL_MS, 5_000, 'RELAY_RECONCILE_INTERVAL_MS'),
    identityPollIntervalMs: positiveInteger(
      env.RELAY_IDENTITY_POLL_INTERVAL_MS,
      30_000,
      'RELAY_IDENTITY_POLL_INTERVAL_MS'
    ),
  };
}
