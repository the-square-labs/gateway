import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { __testOnly } from './nginx-certificate-distribution.service.js';

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
});
