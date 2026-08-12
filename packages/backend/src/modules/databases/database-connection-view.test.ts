import { describe, expect, it } from 'vitest';
import { toDatabaseConnectionView } from './database-connection-view.js';

const row = {
  id: 'database-id',
  name: 'Analytics',
  slug: 'analytics',
  type: 'clickhouse' as const,
  description: null,
  tags: [],
  manualSizeLimitMb: null,
  interactiveQueryBudgetSeconds: 300,
  host: 'clickhouse.example',
  port: 8443,
  databaseName: 'events',
  username: 'analytics',
  tlsEnabled: true,
  healthStatus: 'unknown' as const,
  lastHealthCheckAt: null,
  lastError: null,
  healthHistory: [],
  folderId: null,
  sortOrder: 0,
  createdById: 'user-id',
  updatedById: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const config = {
  type: 'clickhouse' as const,
  url: 'https://clickhouse.example:8443/proxy?compress=1&http_header_X-ClickHouse-Key=test-value#fragment',
  host: 'clickhouse.example',
  port: 8443,
  database: 'events',
  username: 'analytics',
  password: 'test-password',
  tlsEnabled: true,
};

describe('toDatabaseConnectionView', () => {
  it('does not disclose ClickHouse URL query parameters or fragments in ordinary views', () => {
    const view = toDatabaseConnectionView(row, config, false);

    expect(view.config).toMatchObject({
      url: 'https://clickhouse.example:8443/proxy',
      password: '••••••••',
    });
  });

  it('preserves the ClickHouse URL in credential-reveal views', () => {
    const view = toDatabaseConnectionView(row, config, true);

    expect(view.config).toMatchObject({
      url: config.url,
      password: config.password,
    });
  });

  it('fails closed for an invalid stored ClickHouse URL in an ordinary view', () => {
    const view = toDatabaseConnectionView(row, { ...config, url: 'not a URL' }, false);

    expect(view.config).toMatchObject({ url: '' });
  });
});
