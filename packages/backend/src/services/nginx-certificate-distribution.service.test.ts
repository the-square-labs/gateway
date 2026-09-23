import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { runOutsideProxyLocks, withProxyHostLock } from '@/modules/proxy/proxy-host-lock.js';
import {
  __testOnly,
  NGINX_CERTIFICATE_DISTRIBUTION_CAPABILITY as CAPABILITY,
  NginxCertificateDistributionService,
} from './nginx-certificate-distribution.service.js';

describe('NginxCertificateDistributionService helpers', () => {
  it('uses deterministic nodeId ordering for legacy canonical-source selection', () => {
    expect(__testOnly.stableNodeOrder(['node-c', null, 'node-a', 'node-c', undefined, 'node-b'])).toEqual([
      'node-a',
      'node-b',
      'node-c',
    ]);
  });

  it('accepts only the explicit v2 capability', () => {
    expect(__testOnly.nodeHasDistributionCapability({ capabilities: ['nginx_certificate_distribution_v2'] })).toBe(
      true
    );
    expect(__testOnly.nodeHasDistributionCapability({ capabilities: ['nginx_certificate_distribution_v1'] })).toBe(
      false
    );
    expect(__testOnly.nodeHasDistributionCapability({ nginxCertificateDistributionV2: true })).toBe(false);
  });

  it('fingerprints the exact fullchain layout written by the daemon', () => {
    const expected = createHash('sha256')
      .update('leaf\nchain')
      .update('\u0000')
      .update('key')
      .update('\u0000')
      .update('chain')
      .digest('hex');

    expect(__testOnly.fingerprintFor('leaf', 'key', 'chain')).toBe(expected);
    expect(__testOnly.fingerprintFor('leaf\n', 'key', 'chain')).toBe(expected);
  });

  it('treats the target node as part of an immutable deployment revision', () => {
    const onNodeA = __testOnly.deploymentGenerationFor('host', 'node-a', 'config', 'certificate-version');
    const onNodeB = __testOnly.deploymentGenerationFor('host', 'node-b', 'config', 'certificate-version');

    expect(onNodeA).not.toBe(onNodeB);
  });

  it('stores only safe, bounded replica errors', () => {
    const safe = __testOnly.safeError(
      new Error('write /etc/nginx/certs/a.pem failed: -----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----')
    );

    expect(safe).toContain('[redacted path]');
    expect(safe).toContain('[redacted PEM]');
    expect(safe).not.toContain('secret');
  });

  it('does not require a synthetic default node when ordering legacy source nodes', () => {
    expect(__testOnly.stableNodeOrder(['node-b', null, 'node-a'])).toEqual(['node-a', 'node-b']);
  });

  it('excludes cleanup replicas from the active deployment read model', () => {
    const active = { nodeId: 'node-active', status: 'ready' as const, cleanupAfter: null };
    const cleanup = { nodeId: 'node-cleanup', status: 'cleanup_pending' as const, cleanupAfter: new Date() };
    const failedCleanup = { nodeId: 'node-stale', status: 'failed' as const, cleanupAfter: new Date() };

    expect(__testOnly.deployedReplicasOnly([active, cleanup, failedCleanup])).toEqual([active]);
  });

  it('keeps certificate preparation side-effect free until an apply is dispatched', async () => {
    const service = new NginxCertificateDistributionService(
      {} as never,
      {} as never,
      {
        getVersionedCertPaths: vi.fn().mockReturnValue({
          certPath: '/etc/nginx/certs/versioned/cert.pem',
          keyPath: '/etc/nginx/certs/versioned/key.pem',
          chainPath: '/etc/nginx/certs/versioned/chain.pem',
        }),
      } as never,
      { resolveNodeId: vi.fn().mockResolvedValue('node-1') } as never
    );
    vi.spyOn(service as any, 'findAsset').mockResolvedValue({
      id: 'asset-1',
      referenceType: 'ssl',
      referenceId: '11111111-1111-4111-8111-111111111111',
      format: 'v2',
      state: 'ready',
      encryptedMaterial: 'encrypted',
      version: 'a'.repeat(64),
    });
    vi.spyOn(service as any, 'assertNodeSupportsDistribution').mockResolvedValue(undefined);
    vi.spyOn(service as any, 'decryptAsset').mockReturnValue({
      version: 'a'.repeat(64),
      fingerprint: 'b'.repeat(64),
      certificatePem: 'cert',
      keyPem: 'key',
      chainPem: null,
    });
    const markReplica = vi.spyOn(service as any, 'markReplicaById');

    await expect(
      service.prepareForHost({
        sslEnabled: true,
        sslCertificateId: '11111111-1111-4111-8111-111111111111',
        internalCertificateId: null,
        nodeId: 'node-1',
      })
    ).resolves.toMatchObject({ assetId: 'asset-1', nodeId: 'node-1' });

    expect(markReplica).not.toHaveBeenCalled();
  });

  it('deploys a Pages-only certificate as an immutable versioned replica', async () => {
    const sendPagesCommand = vi.fn().mockResolvedValue({});
    const service = new NginxCertificateDistributionService(
      {} as never,
      {} as never,
      {} as never,
      { sendPagesCommand } as never
    );
    vi.spyOn(service, 'prepareForHost').mockResolvedValue({
      assetId: 'asset-1',
      nodeId: 'node-1',
      daemonCertId: '11111111-1111-4111-8111-111111111111',
      version: 'a'.repeat(64),
      fingerprint: 'b'.repeat(64),
      certificatePem: Buffer.from('cert'),
      keyPem: Buffer.from('key'),
      chainPem: Buffer.from('chain'),
      sslCertPath: null,
      sslKeyPath: null,
      sslChainPath: null,
    });
    const markReplica = vi.spyOn(service as any, 'markReplicaById').mockResolvedValue(7);

    await expect(service.deployForPages('node-1', '11111111-1111-4111-8111-111111111111')).resolves.toEqual({
      certificateId: '11111111-1111-4111-8111-111111111111',
      certificateVersion: 'a'.repeat(64),
    });
    expect(sendPagesCommand).toHaveBeenCalledWith('node-1', {
      pagesDeployCertificate: expect.objectContaining({
        version: 'a'.repeat(64),
        replicaGeneration: '7',
        certPem: Buffer.from('cert'),
        keyPem: Buffer.from('key'),
      }),
    });
    expect(markReplica).toHaveBeenCalledWith(
      'asset-1',
      'node-1',
      expect.objectContaining({ status: 'ready', appliedVersion: 'a'.repeat(64) })
    );
  });
});

describe('NginxCertificateDistributionService replica retries', () => {
  const capable = { id: 'node-1', type: 'nginx', status: 'online', capabilities: { capabilities: [CAPABILITY] } };
  const asset = {
    id: 'asset-1',
    referenceType: 'ssl',
    referenceId: '11111111-1111-4111-8111-111111111111',
    fingerprint: 'f'.repeat(64),
    version: 'v'.repeat(64),
  };

  function retryHarness(replica: Record<string, unknown>) {
    const db = {
      query: {
        nginxCertificateReplicas: { findMany: vi.fn().mockResolvedValue([replica]) },
        nginxCertificateAssets: { findMany: vi.fn().mockResolvedValue([asset]) },
      },
    };
    const service = new NginxCertificateDistributionService(db as never, {} as never, {} as never, {} as never);
    vi.spyOn(service as any, 'getNode').mockResolvedValue(capable);
    const repair = vi.spyOn(service as any, 'repairReplica').mockResolvedValue(undefined);
    return { service, repair };
  }

  it('backs off exponentially up to the periodic cadence', () => {
    expect(__testOnly.repairDelayMs(0)).toBe(5 * 60 * 1000);
    expect(__testOnly.repairDelayMs(2)).toBe(20 * 60 * 1000);
    expect(__testOnly.repairDelayMs(40)).toBe(6 * 60 * 60 * 1000);
  });

  it('retries a failed replica push once its backoff elapsed', async () => {
    const { service, repair } = retryHarness({
      assetId: 'asset-1',
      nodeId: 'node-1',
      status: 'failed',
      repairAttempts: 1,
      updatedAt: new Date(Date.now() - 11 * 60 * 1000),
    });

    await service.reconcileIntegrity('node-1');

    expect(repair).toHaveBeenCalledWith(asset, 'node-1');
  });

  it('does not retry a replica inside its backoff window', async () => {
    const { service, repair } = retryHarness({
      assetId: 'asset-1',
      nodeId: 'node-1',
      status: 'pending',
      repairAttempts: 0,
      updatedAt: new Date(),
    });

    await service.reconcileIntegrity('node-1');

    expect(repair).not.toHaveBeenCalled();
  });
});

// Regression: repair re-pushed deployment.configContent outside the per-host lock, racing a host apply.
describe('NginxCertificateDistributionService replica repair locking', () => {
  it('waits for the host lock and pushes the deployment committed by the holder', async () => {
    const asset = { id: 'asset-1', referenceType: 'ssl', referenceId: 'cert-1' };
    let current = { hostId: 'host-1', configContent: 'old-config', generation: 1 };
    const db = {
      query: {
        nginxProxyHostDeployments: { findMany: vi.fn(async () => [current]) },
        nginxCertificateReplicas: { findFirst: vi.fn().mockResolvedValue({ generation: 3 }) },
      },
    };
    const applyTlsBundle = vi.fn().mockResolvedValue({ success: true });
    const service = new NginxCertificateDistributionService(
      db as never,
      {} as never,
      {} as never,
      {
        applyTlsBundle,
      } as never
    );
    vi.spyOn(service as any, 'decryptAsset').mockReturnValue({
      certificatePem: 'cert',
      keyPem: 'key',
      chainPem: null,
      version: 'v1',
      fingerprint: 'f',
    });
    vi.spyOn(service as any, 'markReplicaById').mockResolvedValue(1);
    vi.spyOn(service as any, 'clearDistributionIncompleteIfSettled').mockResolvedValue(undefined);

    let repair!: Promise<void>;
    await withProxyHostLock('host-1', async () => {
      // Started as independent background work, like the integrity reconcile.
      repair = runOutsideProxyLocks(() => (service as any).repairReplica(asset, 'node-1'));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(applyTlsBundle).not.toHaveBeenCalled();
      current = { hostId: 'host-1', configContent: 'new-config', generation: 2 };
    });
    await repair;

    expect(applyTlsBundle).toHaveBeenCalledTimes(1);
    expect(applyTlsBundle.mock.calls[0][1]).toMatchObject({
      hostId: 'host-1',
      configContent: 'new-config',
      generation: 2,
    });
  });
});

describe('NginxCertificateDistributionService legacy daemon delivery', () => {
  const host = {
    id: 'host-1',
    nodeId: 'node-1',
    sslEnabled: true,
    sslCertificateId: '11111111-1111-4111-8111-111111111111',
    internalCertificateId: null,
  };

  function legacyHarness(node: Record<string, unknown>, deployResult: { success: boolean; error?: string }) {
    const nodeDispatch = {
      resolveNodeId: vi.fn().mockResolvedValue('node-1'),
      isNodeConnected: vi.fn().mockReturnValue(true),
      deployCertificate: vi.fn().mockResolvedValue(deployResult),
    };
    const service = new NginxCertificateDistributionService(
      {} as never,
      {} as never,
      {} as never,
      nodeDispatch as never
    );
    vi.spyOn(service as any, 'getNode').mockResolvedValue(node);
    vi.spyOn(service as any, 'loadGatewayMaterial').mockResolvedValue({
      certificatePem: 'cert',
      keyPem: 'key',
      chainPem: 'chain',
    });
    vi.spyOn(service as any, 'findAsset').mockResolvedValue({ id: 'asset-1' });
    const markReplica = vi.spyOn(service as any, 'markReplicaById').mockResolvedValue(0);
    const reapply = vi.fn().mockResolvedValue(undefined);
    service.setLegacyHostConfigReapplier(reapply);
    return { service, nodeDispatch, markReplica, reapply };
  }

  const legacyNode = { id: 'node-1', type: 'nginx', status: 'online', capabilities: { capabilities: [] } };

  it('pushes the certificate with deployCert and re-applies the host config', async () => {
    const { service, nodeDispatch, markReplica, reapply } = legacyHarness(legacyNode, { success: true });

    await expect(service.deployLegacyCertificateForHost(host)).resolves.toBe('delivered');

    expect(nodeDispatch.deployCertificate).toHaveBeenCalledWith(
      'node-1',
      host.sslCertificateId,
      Buffer.from('cert'),
      Buffer.from('key'),
      Buffer.from('chain')
    );
    expect(reapply).toHaveBeenCalledWith('host-1');
    expect(markReplica).toHaveBeenCalledWith(
      'asset-1',
      'node-1',
      expect.objectContaining({ status: 'daemon_update_required', appliedVersion: expect.any(String) })
    );
  });

  it('records a retryable failure when the legacy daemon rejects the push', async () => {
    const { service, markReplica, reapply } = legacyHarness(legacyNode, { success: false, error: 'disk full' });

    await expect(service.deployLegacyCertificateForHost(host)).rejects.toMatchObject({
      code: 'NGINX_TLS_LEGACY_DEPLOY_FAILED',
    });
    expect(reapply).not.toHaveBeenCalled();
    expect(markReplica).toHaveBeenCalledWith(
      'asset-1',
      'node-1',
      expect.objectContaining({ status: 'failed', lastError: 'disk full' })
    );
  });

  it('leaves v2 daemons to the bundle path', async () => {
    const { service, nodeDispatch } = legacyHarness(
      { ...legacyNode, status: 'offline', capabilities: { capabilities: [CAPABILITY] } },
      { success: true }
    );

    await expect(service.deployLegacyCertificateForHost(host)).resolves.toBe('not_legacy');
    expect(nodeDispatch.deployCertificate).not.toHaveBeenCalled();
  });
});

describe('NginxCertificateDistributionService legacy reconnect retries', () => {
  const legacyNode = { id: 'node-1', type: 'nginx', status: 'online', capabilities: { capabilities: [] } };
  const certId = '11111111-1111-4111-8111-111111111111';
  const asset = { id: 'asset-1', referenceType: 'ssl', referenceId: certId, state: 'ready', version: 'v2'.repeat(32) };
  const hostRow = {
    id: 'host-1',
    nodeId: 'node-1',
    sslEnabled: true,
    sslCertificateId: certId,
    internalCertificateId: null,
  };

  function harness(replicas: Array<Record<string, unknown>>, unsettled: Array<{ id: string }> = []) {
    const clearedWhere = vi.fn();
    const updateSet = vi.fn(() => ({
      where: vi.fn((condition: unknown) => {
        clearedWhere(condition);
        return { returning: vi.fn(async () => [{ id: certId }]) };
      }),
    }));
    let selectCall = 0;
    const db = {
      query: {
        nginxCertificateReplicas: { findMany: vi.fn().mockResolvedValue(replicas) },
        nginxCertificateAssets: { findFirst: vi.fn().mockResolvedValue(asset) },
      },
      // 1st select: hosts using the certificate on the node; 2nd: unsettled replicas.
      select: vi.fn(() => {
        selectCall += 1;
        const rows = selectCall === 1 ? [hostRow] : unsettled;
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => Object.assign(Promise.resolve(rows), { limit: vi.fn(async () => rows) })),
          })),
        };
      }),
      update: vi.fn(() => ({ set: updateSet })),
    };
    const service = new NginxCertificateDistributionService(db as never, {} as never, {} as never, {} as never);
    const eventBus = { publish: vi.fn() };
    service.setEventBus(eventBus as never);
    vi.spyOn(service as any, 'getNode').mockResolvedValue(legacyNode);
    const deploy = vi.spyOn(service, 'deployLegacyCertificateForHost').mockResolvedValue('delivered');
    return { service, deploy, db, updateSet, eventBus };
  }

  const offlineAtRenewal = {
    assetId: 'asset-1',
    nodeId: 'node-1',
    status: 'failed',
    repairAttempts: 0,
    desiredVersion: 'v2'.repeat(32),
    appliedVersion: 'v1'.repeat(32),
    updatedAt: new Date(),
  };

  it('pushes a certificate renewed while the node was offline as soon as it reconnects', async () => {
    const { service, deploy } = harness([offlineAtRenewal]);

    await service.reconcileIntegrity('node-1', { reconnect: true });

    expect(deploy).toHaveBeenCalledWith(hostRow, { reapplyHostIds: ['host-1'] });
  });

  it('keeps the backoff for the periodic pass', async () => {
    const { service, deploy } = harness([offlineAtRenewal]);

    await service.reconcileIntegrity('node-1');

    expect(deploy).not.toHaveBeenCalled();
  });

  it('pushes a legacy replica whose delivered version is older than the canonical asset', async () => {
    const { service, deploy } = harness([
      {
        ...offlineAtRenewal,
        status: 'daemon_update_required',
        desiredVersion: 'v1'.repeat(32),
        appliedVersion: 'v1'.repeat(32),
      },
    ]);

    await service.reconcileIntegrity('node-1', { reconnect: true });

    expect(deploy).toHaveBeenCalledTimes(1);
  });

  it('leaves an up-to-date legacy replica alone', async () => {
    const { service, deploy } = harness([
      {
        ...offlineAtRenewal,
        status: 'daemon_update_required',
        desiredVersion: asset.version,
        appliedVersion: asset.version,
      },
    ]);

    await service.reconcileIntegrity('node-1', { reconnect: true });

    expect(deploy).not.toHaveBeenCalled();
  });

  it('clears the "Distribution incomplete" status once the automatic retry delivered everywhere', async () => {
    const { service, updateSet, eventBus } = harness([offlineAtRenewal]);

    await service.reconcileIntegrity('node-1', { reconnect: true });

    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ renewalError: null }));
    expect(eventBus.publish).toHaveBeenCalledWith('ssl.cert.changed', { id: certId, action: 'updated' });
  });

  it('keeps the status while another replica of the certificate is still failing', async () => {
    const { service, updateSet } = harness([offlineAtRenewal], [{ id: 'replica-2' }]);

    await service.reconcileIntegrity('node-1', { reconnect: true });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it('does not clear the status when the retry fails', async () => {
    const { service, deploy, updateSet } = harness([offlineAtRenewal]);
    deploy.mockRejectedValueOnce(new Error('offline'));
    vi.spyOn(service as any, 'markReplicaById').mockResolvedValue(0);

    await service.reconcileIntegrity('node-1', { reconnect: true });

    expect(updateSet).not.toHaveBeenCalled();
  });
});

describe('NginxCertificateDistributionService internal certificate guards', () => {
  function materialHarness(cert: Record<string, unknown>, issuer: Record<string, unknown>) {
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'where']) chain[method] = vi.fn(() => chain);
    chain.limit = vi.fn().mockResolvedValue([issuer]);
    const db = {
      query: { certificates: { findFirst: vi.fn().mockResolvedValue(cert) } },
      select: vi.fn(() => chain),
    };
    const cryptoService = { decryptPrivateKey: vi.fn() };
    const service = new NginxCertificateDistributionService(
      db as never,
      cryptoService as never,
      {} as never,
      {} as never
    );
    return { service, cryptoService };
  }

  const internal = {
    caId: 'ca-1',
    certificatePem: 'cert',
    encryptedPrivateKey: 'enc',
    encryptedDek: 'dek',
    status: 'active',
    type: 'tls-server',
  };

  it.each([
    ['a revoked certificate', { ...internal, status: 'revoked' }, { isSystem: false }],
    ['a client certificate', { ...internal, type: 'tls-client' }, { isSystem: false }],
    ['a system-CA certificate', internal, { isSystem: true }],
  ])('never decrypts %s for Nginx', async (_label, cert, issuer) => {
    const { service, cryptoService } = materialHarness(cert, issuer);

    await expect(
      (service as any).loadGatewayMaterial({ type: 'internal', id: '11111111-1111-4111-8111-111111111111' })
    ).rejects.toMatchObject({ code: 'TLS_CERTIFICATE_NOT_DEPLOYABLE' });
    expect(cryptoService.decryptPrivateKey).not.toHaveBeenCalled();
  });
});
