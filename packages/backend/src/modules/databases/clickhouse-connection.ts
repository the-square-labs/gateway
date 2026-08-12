import { type ClickHouseClient, createClient } from '@clickhouse/client';
import { AppError } from '@/middleware/error-handler.js';
import type { ClickHouseConnectionConfig } from './database-connection-view.js';

export type ClickHouseConnectionInput = Partial<ClickHouseConnectionConfig> & {
  connectionString?: string;
  url?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  tlsEnabled?: boolean;
};

export function normalizeClickHouseConnection(config: ClickHouseConnectionInput): ClickHouseConnectionConfig {
  const hasConnectionString = Boolean(config.connectionString?.trim());
  const rawUrl =
    config.connectionString?.trim() ||
    config.url?.trim() ||
    (config.host
      ? `${config.tlsEnabled ? 'https' : 'http'}://${config.host.trim()}:${config.port ?? (config.tlsEnabled ? 8443 : 8123)}`
      : '');
  if (!rawUrl) {
    throw new AppError(400, 'INVALID_DATABASE_CONFIG', 'ClickHouse connections require an HTTP(S) URL or host');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AppError(400, 'INVALID_CONNECTION_STRING', 'Invalid ClickHouse connection URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AppError(400, 'INVALID_CONNECTION_STRING', 'ClickHouse connections require an HTTP(S) URL');
  }

  const username = config.username?.trim() || (parsed.username ? decodeURIComponent(parsed.username) : 'default');
  const password = config.password ?? (parsed.password ? decodeURIComponent(parsed.password) : '');
  const database = config.database?.trim() || parsed.searchParams.get('database')?.trim() || 'default';
  if (!username || !database) {
    throw new AppError(400, 'INVALID_DATABASE_CONFIG', 'ClickHouse connections require database and username');
  }

  if (!hasConnectionString && config.host?.trim()) parsed.hostname = config.host.trim();
  if (!hasConnectionString && config.tlsEnabled !== undefined) {
    parsed.protocol = config.tlsEnabled ? 'https:' : 'http:';
  }
  const port =
    !hasConnectionString && config.port != null
      ? config.port
      : Number(parsed.port || (parsed.protocol === 'https:' ? 8443 : 8123));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError(400, 'INVALID_DATABASE_CONFIG', 'ClickHouse port must be between 1 and 65535');
  }
  parsed.port = String(port);
  parsed.username = '';
  parsed.password = '';
  parsed.searchParams.delete('database');

  return {
    type: 'clickhouse',
    url: parsed.toString(),
    host: parsed.hostname,
    port,
    database,
    username,
    password,
    tlsEnabled: parsed.protocol === 'https:',
  };
}

export function createClickHouseDatabaseClient(
  config: ClickHouseConnectionConfig,
  maxOpenConnections: number
): ClickHouseClient {
  return createClient({
    url: config.url,
    username: config.username,
    password: config.password,
    database: config.database,
    // Per-statement execution is bounded by an absolute console deadline.
    // Keep the transport ceiling above the largest configurable 600s budget.
    request_timeout: 610_000,
    max_open_connections: maxOpenConnections,
    application: 'gateway-database-connector',
    clickhouse_settings: {
      output_format_json_quote_64bit_integers: 1,
      cancel_http_readonly_queries_on_client_close: 1,
    },
  });
}
