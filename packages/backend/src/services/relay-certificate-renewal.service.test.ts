import { createHash, X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { describe, expect, it, vi } from 'vitest';
import { relayInstances } from '@/db/schema/index.js';
import {
  RELAY_CERTIFICATE_RENEW_BEFORE_MS,
  RelayCertificateRenewalService,
} from './relay-certificate-renewal.service.js';

const DAY = 24 * 60 * 60 * 1000;

function certificatePem(commonName: string, notAfter: Date): string {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = '0a';
  certificate.validity.notBefore = new Date(Date.now() - DAY);
  certificate.validity.notAfter = notAfter;
  certificate.setSubject([{ name: 'commonName', value: commonName }]);
  certificate.setIssuer([{ name: 'commonName', value: 'gateway-system-ca' }]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(certificate);
}

function relay(overrides: Record<string, unknown> = {}) {
  return {
    id: 'relay-1',
    poolId: 'system',
    kind: 'remote',
    nodeId: 'node-1',
    advertisedAddresses: ['relay.example.test', '[2001:db8::1]'],
    certificateFingerprint: 'sha256:pinned',
    certificateExpiresAt: new Date(Date.now() + 10 * DAY),
    capabilities: { protocolMajor: 1, features: ['relay_pool_v1', 'server_certificate_rollover_v1'] },
    ...overrides,
  };
}

function harness(
  options: { dispatchResult?: { success: boolean; error?: string }; connected?: boolean; rows?: unknown[] } = {}
) {
  const renewedExpiry = new Date(Date.now() + 365 * DAY);
  let issuedName = '';
  const lifecycle = {
    issuePending: vi.fn(async (input: { commonName: string }) => {
      issuedName = input.commonName;
      return {
        certificate: { certificatePem: certificatePem(input.commonName, renewedExpiry), serialNumber: 'serial-2' },
        privateKeyPem: 'renewed-key',
      };
    }),
    promotePending: vi.fn(async (_owner: unknown, _serial: string, bind: (tx: any, promoted: any) => Promise<void>) => {
      await bind(tx, { id: 'cert-2', serialNumber: 'serial-2', notAfter: renewedExpiry, certificatePem: '' });
      return true;
    }),
  };
  const writes: Array<{ table: unknown; values: any }> = [];
  const tx = {
    update: (table: unknown) => ({
      set: (values: unknown) => ({
        where: async () => {
          writes.push({ table, values });
        },
      }),
    }),
  };
  const rows: unknown[] = options.rows ?? [relay()];
  const db = {
    select: () => {
      const query: any = Promise.resolve(rows);
      for (const method of ['from', 'where', 'limit']) query[method] = () => query;
      return query;
    },
  };
  const dispatch = {
    renewRelayIdentity: vi.fn().mockResolvedValue(options.dispatchResult ?? { success: true, detail: 'ok' }),
    isNodeConnected: vi.fn(() => options.connected ?? true),
  };
  const policy = { refreshAllNodeGrantsIfDue: vi.fn().mockResolvedValue(undefined) };
  const audit = { log: vi.fn().mockResolvedValue(true) };
  const service = new RelayCertificateRenewalService(
    db as never,
    lifecycle as never,
    { getSystemCAId: vi.fn().mockResolvedValue('ca-1') },
    dispatch as never,
    policy,
    audit
  );
  return { service, lifecycle, dispatch, policy, audit, writes, rows, identity: () => issuedName, renewedExpiry };
}

describe('RelayCertificateRenewalService', () => {
  it('stages a renewed certificate under a new identity and publishes it only after the relay serves it', async () => {
    const { service, lifecycle, dispatch, policy, audit, writes, identity, renewedExpiry } = harness();

    await expect(service.renewDue()).resolves.toBe(1);

    const [input, , owner] = lifecycle.issuePending.mock.calls[0] as unknown as [any, string, any];
    expect(owner).toEqual({ type: 'relay_node_server', id: 'relay-1' });
    expect(identity()).toMatch(/^relay-relay-1-[0-9a-f]{8}$/);
    expect(input).toMatchObject({ type: 'tls-server', validityDays: 365 });
    expect(input.sans).toEqual([identity(), 'relay.example.test', '2001:db8::1']);
    expect(dispatch.renewRelayIdentity).toHaveBeenCalledWith('node-1', {
      serverCertificate: expect.any(Buffer),
      serverKey: Buffer.from('renewed-key'),
      serverIdentity: identity(),
      retainServerFingerprint: 'sha256:pinned',
    });
    const sent = (dispatch.renewRelayIdentity.mock.calls[0] as unknown as [string, any])[1];
    const fingerprint = `sha256:${createHash('sha256').update(new X509Certificate(sent.serverCertificate).raw).digest('hex')}`;
    expect(lifecycle.promotePending).toHaveBeenCalledWith(owner, 'serial-2', expect.any(Function));
    expect(writes).toEqual([
      {
        table: relayInstances,
        values: expect.objectContaining({
          certificateIdentity: identity(),
          certificateFingerprint: fingerprint,
          certificateExpiresAt: renewedExpiry,
        }),
      },
    ]);
    expect(policy.refreshAllNodeGrantsIfDue).toHaveBeenCalledWith(true);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'relay.instance.certificate.renew', resourceId: 'relay-1' })
    );
  });

  it('keeps the published certificate when the relay does not confirm, and says what to do', async () => {
    const { service, lifecycle, writes, dispatch } = harness({
      dispatchResult: { success: false, error: 'unsupported command for relay supervisor' },
    });

    await expect(service.renewDue()).resolves.toBe(0);
    expect(lifecycle.promotePending).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    const status = service.describeCertificates([relay()] as never).get('relay-1');
    expect(status).toMatchObject({ state: 'renewal_failed', message: expect.stringContaining('re-enroll') });

    // Retried hourly, not on every reconciliation pass.
    await service.renewDue();
    expect(dispatch.renewRelayIdentity).toHaveBeenCalledTimes(1);
  });

  it('waits for the supervisor connection, which is the authenticated channel', async () => {
    const { service, dispatch } = harness({ connected: false });
    await expect(service.renewDue()).resolves.toBe(0);
    expect(dispatch.renewRelayIdentity).not.toHaveBeenCalled();
    await expect(service.renewInstanceCertificate('relay-1', 'admin')).rejects.toMatchObject({
      code: 'RELAY_NOT_CONNECTED',
    });
  });

  it('describes expired and expiring certificates and points an expired relay to re-enrollment', () => {
    const { service } = harness();
    const now = new Date();
    const statuses = service.describeCertificates(
      [
        relay({ id: 'expired', certificateExpiresAt: new Date(now.getTime() - DAY) }),
        relay({ id: 'expiring', certificateExpiresAt: new Date(now.getTime() + 5 * DAY) }),
        relay({ id: 'fine', certificateExpiresAt: new Date(now.getTime() + RELAY_CERTIFICATE_RENEW_BEFORE_MS + DAY) }),
        relay({ id: 'local', kind: 'local', certificateExpiresAt: new Date(now.getTime() - DAY) }),
      ] as never,
      now
    );
    expect(statuses.get('expired')).toMatchObject({ state: 'expired', message: expect.stringContaining('re-enroll') });
    expect(statuses.get('expiring')).toMatchObject({ state: 'expiring' });
    expect(statuses.has('fine')).toBe(false);
    expect(statuses.has('local')).toBe(false);
  });

  it('checks for due renewals at most hourly and never twice at once', async () => {
    const { service } = harness();
    const renewDue = vi.spyOn(service, 'renewDue').mockResolvedValue(0);
    await service.renewDueIfScheduled(1_000);
    await service.renewDueIfScheduled(2_000);
    expect(renewDue).toHaveBeenCalledTimes(1);
    await service.renewDueIfScheduled(1_000 + 60 * 60 * 1000);
    expect(renewDue).toHaveBeenCalledTimes(2);
  });

  it('refuses to renew on a worker that would stop serving the certificate daemons pin', async () => {
    const { service, dispatch, lifecycle } = harness({
      rows: [relay({ capabilities: { protocolMajor: 1, features: ['relay_pool_v1'] } })],
    });
    await expect(service.renewDue()).resolves.toBe(0);
    expect(lifecycle.issuePending).not.toHaveBeenCalled();
    expect(dispatch.renewRelayIdentity).not.toHaveBeenCalled();
    expect(service.describeCertificates([relay()] as never).get('relay-1')).toMatchObject({
      state: 'renewal_failed',
      message: expect.stringContaining('Update the Relay Pool'),
    });
  });

  it('refreshes daemon grants once for a whole renewal pass', async () => {
    const { service, policy, dispatch } = harness({ rows: [relay(), relay({ id: 'relay-2', nodeId: 'node-2' })] });
    await expect(service.renewDue()).resolves.toBe(2);
    expect(dispatch.renewRelayIdentity).toHaveBeenCalledTimes(2);
    expect(policy.refreshAllNodeGrantsIfDue).toHaveBeenCalledTimes(1);
  });

  it('does not renew again before daemons had a day to receive the last renewal', async () => {
    const { service, dispatch } = harness({
      rows: [relay({ certificateExpiresAt: new Date(Date.now() + 365 * DAY - 60_000) })],
    });
    await expect(service.renewInstanceCertificate('relay-1', 'admin')).rejects.toMatchObject({
      code: 'RELAY_CERTIFICATE_RECENTLY_RENEWED',
    });
    expect(dispatch.renewRelayIdentity).not.toHaveBeenCalled();
  });
});
