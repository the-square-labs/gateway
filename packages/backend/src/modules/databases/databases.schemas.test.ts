import { describe, expect, it } from 'vitest';
import {
  CreateDatabaseConnectionSchema,
  CreateManagedDatabaseSchema,
  UpdateDatabaseConnectionSchema,
} from './databases.schemas.js';

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

describe('database connection TLS verification fields', () => {
  const ca = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';

  it.each([
    ['postgres', { host: 'db.example.com', sslEnabled: true }],
    ['redis', { host: 'redis.example.com', tlsEnabled: true }],
    ['clickhouse', { host: 'ch.example.com', tlsEnabled: true }],
  ] as const)('keeps the verification setting and CA for %s connections', (type, config) => {
    const result = CreateDatabaseConnectionSchema.parse({
      name: 'Primary',
      type,
      config: { ...config, tlsVerifyCertificate: false, tlsCaCertificate: ` ${ca} ` },
    });

    expect(result.config).toMatchObject({ tlsVerifyCertificate: false, tlsCaCertificate: ca });
  });

  it('accepts enabling verification or clearing the CA on update', () => {
    expect(UpdateDatabaseConnectionSchema.parse({ config: { tlsVerifyCertificate: true } }).config).toEqual({
      tlsVerifyCertificate: true,
    });
    expect(UpdateDatabaseConnectionSchema.parse({ config: { tlsCaCertificate: null } }).config).toEqual({
      tlsCaCertificate: null,
    });
  });

  it('rejects an oversized CA bundle', () => {
    expect(UpdateDatabaseConnectionSchema.safeParse({ config: { tlsCaCertificate: 'x'.repeat(65_537) } }).success).toBe(
      false
    );
  });
});

describe('CreateManagedDatabaseSchema', () => {
  const base = {
    name: 'Orders',
    type: 'postgres',
    version: '17.10',
    nodeId: '22222222-2222-4222-8222-222222222222',
    storageSizeGb: 20,
    cpuCores: 1,
    memoryMb: 1024,
  };

  it('accepts only database names the database daemon can create', () => {
    expect(CreateManagedDatabaseSchema.safeParse({ ...base, databaseName: 'orders_2026' }).success).toBe(true);
    for (const databaseName of ['my-app', '1st', 'a b', 'x'.repeat(64)]) {
      expect(CreateManagedDatabaseSchema.safeParse({ ...base, databaseName }).success, databaseName).toBe(false);
    }
  });
});
