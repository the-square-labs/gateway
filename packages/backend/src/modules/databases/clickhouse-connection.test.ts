import { describe, expect, it } from 'vitest';
import { normalizeClickHouseConnection } from './clickhouse-connection.js';

describe('normalizeClickHouseConnection', () => {
  it('normalizes a ClickHouse Cloud URL and removes credentials from the stored endpoint', () => {
    const config = normalizeClickHouseConnection({
      connectionString: 'https://analytics:secret@example.clickhouse.cloud?database=events&compress=1',
      port: 8123,
      tlsEnabled: false,
    });

    expect(config).toMatchObject({
      type: 'clickhouse',
      host: 'example.clickhouse.cloud',
      port: 8443,
      database: 'events',
      username: 'analytics',
      password: 'secret',
      tlsEnabled: true,
    });
    expect(config.url).toBe('https://example.clickhouse.cloud:8443/?compress=1');
  });

  it('applies explicit host, port, and TLS edits while preserving an existing URL path', () => {
    const config = normalizeClickHouseConnection({
      url: 'http://old.example.test:8123/clickhouse?compress=1',
      host: 'new.example.test',
      port: 8443,
      tlsEnabled: true,
      database: 'analytics',
      username: 'default',
      password: 'secret',
    });

    expect(config.url).toBe('https://new.example.test:8443/clickhouse?compress=1');
    expect(config).toMatchObject({
      host: 'new.example.test',
      port: 8443,
      tlsEnabled: true,
      database: 'analytics',
    });
  });

  it('rejects the native ClickHouse protocol because the connector uses HTTP(S)', () => {
    expect(() => normalizeClickHouseConnection({ connectionString: 'clickhouse://localhost:9000/default' })).toThrow(
      'ClickHouse connections require an HTTP(S) URL'
    );
  });
});
