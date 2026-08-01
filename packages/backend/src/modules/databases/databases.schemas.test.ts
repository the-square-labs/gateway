import { describe, expect, it } from 'vitest';
import { CreateDatabaseConnectionSchema } from './databases.schemas.js';

describe('CreateDatabaseConnectionSchema', () => {
  it('does not retain a manual size limit for ClickHouse connections', () => {
    const result = CreateDatabaseConnectionSchema.parse({
      name: 'Analytics ClickHouse',
      type: 'clickhouse',
      manualSizeLimitMb: 2048,
      config: {
        host: 'ch.example.com',
        port: 8443,
        database: 'analytics',
        username: 'reporter',
        password: 'secret',
        tlsEnabled: true,
      },
    });

    expect(result).not.toHaveProperty('manualSizeLimitMb');
  });
});
