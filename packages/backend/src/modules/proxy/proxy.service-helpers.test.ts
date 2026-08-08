import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';

vi.mock('@/config/env.js', () => ({
  getEnv: () => ({ PORT: 3000 }),
}));

vi.mock('@/db/schema/access-lists.js', () => ({
  accessLists: { id: 'access_lists.id' },
}));

vi.mock('@/db/schema/certificates.js', () => ({
  certificates: { id: 'certificates.id' },
}));

vi.mock('@/db/schema/index.js', () => ({
  proxyHosts: {
    id: 'proxy_hosts.id',
    isSystem: 'proxy_hosts.is_system',
    type: 'proxy_hosts.type',
    enabled: 'proxy_hosts.enabled',
    healthStatus: 'proxy_hosts.health_status',
    domainNames: 'proxy_hosts.domain_names',
    nodeId: 'proxy_hosts.node_id',
    createdAt: 'proxy_hosts.created_at',
    systemKind: 'proxy_hosts.system_kind',
  },
}));

vi.mock('@/db/schema/ssl-certificates.js', () => ({
  sslCertificates: { id: 'ssl_certificates.id' },
}));

const { __testOnly } = await import('./proxy.service.js');

describe('ProxyService helpers', () => {
  it('matches expected health-check bodies with the supported modes', () => {
    expect(__testOnly.matchesExpectedBody('gateway status ok', 'status', 'includes')).toBe(true);
    expect(__testOnly.matchesExpectedBody('gateway status ok', 'gateway', 'starts_with')).toBe(true);
    expect(__testOnly.matchesExpectedBody('gateway status ok', 'ok', 'ends_with')).toBe(true);
    expect(__testOnly.matchesExpectedBody('gateway status ok', 'gateway status ok', 'exact')).toBe(true);
    expect(__testOnly.matchesExpectedBody('gateway status ok', 'missing', 'includes')).toBe(false);
  });

  it('normalizes validation options and raw config audit details', () => {
    expect(__testOnly.normalizeProxyValidationOptions(true)).toEqual({
      bypassAdvancedValidation: true,
      bypassRawValidation: false,
    });
    expect(__testOnly.normalizeProxyValidationOptions({ bypassRawValidation: true })).toEqual({
      bypassRawValidation: true,
    });
    expect(__testOnly.rawConfigAuditDetails({}, { bypassRawValidation: true })).toEqual({});
    expect(__testOnly.rawConfigAuditDetails({ rawConfig: 'server {}' }, { bypassRawValidation: true })).toEqual({
      rawConfigChanged: true,
      rawValidationBypassed: true,
    });
  });

  it('keeps dormant upstream data across raw-mode transitions', () => {
    const linkedHost = { type: 'proxy', rawConfigEnabled: false };

    expect(__testOnly.updateUsesRawMode(linkedHost, { type: 'raw', rawConfigEnabled: true })).toBe(true);
    expect(
      __testOnly.updateUsesRawMode(
        { ...linkedHost, type: 'raw', rawConfigEnabled: true },
        { type: 'proxy', rawConfigEnabled: false }
      )
    ).toBe(false);
  });

  it('validates stored raw config when an update newly enables raw mode', () => {
    const existing = { type: 'proxy', rawConfigEnabled: false, rawConfig: 'server { deny all; }' };

    expect(
      __testOnly.storedRawConfigForRawModeEnablement(existing, { rawConfigEnabled: true })
    ).toBe('server { deny all; }');
    expect(__testOnly.storedRawConfigForRawModeEnablement(existing, { type: 'raw' })).toBe('server { deny all; }');
  });

  it('does not revalidate a stored raw config for unrelated updates or a supplied replacement', () => {
    const existing = { type: 'proxy', rawConfigEnabled: false, rawConfig: 'server { deny all; }' };

    expect(
      __testOnly.storedRawConfigForRawModeEnablement(existing, { enabled: false } as any)
    ).toBeUndefined();
    expect(
      __testOnly.storedRawConfigForRawModeEnablement(existing, {
        rawConfigEnabled: true,
        rawConfig: 'server { return 200; }',
      })
    ).toBeUndefined();
    expect(
      __testOnly.storedRawConfigForRawModeEnablement(
        { ...existing, type: 'raw', rawConfigEnabled: true },
        { rawConfigEnabled: true }
      )
    ).toBeUndefined();
  });

  it('does not block unrelated updates when an existing host has stale SSL state without a certificate', () => {
    expect(() =>
      __testOnly.assertSslPrerequisitesForUpdate(
        { sslEnabled: true, sslCertificateId: null, internalCertificateId: null },
        { accessListId: 'access-list-1' } as any
      )
    ).not.toThrow();
  });

  it('still requires a certificate when enabling SSL or removing the certificate from enabled SSL', () => {
    expect(() =>
      __testOnly.assertSslPrerequisitesForUpdate(
        { sslEnabled: false, sslCertificateId: null, internalCertificateId: null },
        { sslEnabled: true }
      )
    ).toThrow(AppError);

    expect(() =>
      __testOnly.assertSslPrerequisitesForUpdate(
        { sslEnabled: true, sslCertificateId: 'cert-1', internalCertificateId: null },
        { sslCertificateId: null }
      )
    ).toThrow(AppError);
  });

  it('strips proxy health history without mutating the remaining host fields', () => {
    expect(
      __testOnly.stripProxyHealthHistory({
        id: 'host-1',
        domainNames: ['app.example.com'],
        healthHistory: [{ status: 'online' }],
      })
    ).toEqual({
      id: 'host-1',
      domainNames: ['app.example.com'],
    });
  });

  it('builds status page system host rollback data from persisted host fields only', () => {
    const rollback = __testOnly.buildStatusPageSystemHostRollbackData({
      type: 'proxy',
      domainNames: ['status.example.com'],
      updatedAt: new Date('2026-06-21T00:00:00.000Z'),
      extraField: 'ignore-me',
    } as any);

    expect(rollback.type).toBe('proxy');
    expect(rollback.domainNames).toEqual(['status.example.com']);
    expect(rollback.updatedAt).toEqual(new Date('2026-06-21T00:00:00.000Z'));
    expect(rollback).not.toHaveProperty('extraField');
    expect(rollback).toHaveProperty('healthStatus');
  });

  it('parses explicit status page upstream URLs and rejects unsafe shapes', () => {
    expect(__testOnly.getStatusPageUpstream('https://status-upstream.example.com:8443')).toEqual({
      host: 'status-upstream.example.com',
      port: 8443,
      scheme: 'https',
    });
    expect(__testOnly.getStatusPageUpstream('http://127.0.0.1')).toEqual({
      host: '127.0.0.1',
      port: 80,
      scheme: 'http',
    });

    expect(() => __testOnly.getStatusPageUpstream('tcp://127.0.0.1:3000')).toThrow(AppError);
    expect(() => __testOnly.getStatusPageUpstream('http://127.0.0.1:3000/status')).toThrow(AppError);
  });
});
