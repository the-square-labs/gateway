import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DockerRegistryTokenService, dockerRegistryTokenContract } from './docker-registry-token.service.js';

let tempDir = '';

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('DockerRegistryTokenService', () => {
  it('issues a Distribution-compatible RS256 token only for the allowed repository actions', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-registry-token-'));
    const service = new DockerRegistryTokenService(tempDir);
    await service.initialize();
    const issued = service.issueToken({
      subject: 'builder:node-1:build-1',
      requested: [{ repository: 'gateway/source-1', actions: ['pull', 'push'] }],
      allowed: [{ repository: 'gateway/source-1', actions: ['pull', 'push'] }],
      context: { nodeId: 'node-1', buildId: 'build-1' },
      ttlSeconds: 120,
      now: new Date('2026-08-24T00:00:00.000Z'),
    });
    const [encodedHeader, encodedPayload, encodedSignature] = issued.token.split('.');
    const header = JSON.parse(Buffer.from(encodedHeader!, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(encodedPayload!, 'base64url').toString('utf8'));
    expect(header.alg).toBe('RS256');
    const publicJwk = createPublicKey(service.getCertificatePem()).export({ format: 'jwk' });
    expect(header.kid).toBe(
      createHash('sha256')
        .update(JSON.stringify({ e: publicJwk.e, kty: publicJwk.kty, n: publicJwk.n }))
        .digest('base64url')
    );
    expect(payload).toMatchObject({
      iss: dockerRegistryTokenContract.issuer,
      aud: dockerRegistryTokenContract.service,
      sub: 'builder:node-1:build-1',
      access: [{ type: 'repository', name: 'gateway/source-1', actions: ['pull', 'push'] }],
      gateway: { node_id: 'node-1', build_id: 'build-1' },
    });
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        createPublicKey(service.getCertificatePem()),
        Buffer.from(encodedSignature!, 'base64url')
      )
    ).toBe(true);
  });

  it('denies cross-repository and cross-action escalation', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-registry-token-'));
    const service = new DockerRegistryTokenService(tempDir);
    await service.initialize();
    expect(() =>
      service.issueToken({
        subject: 'runtime:node-1:deployment-1',
        requested: [{ repository: 'gateway/source-2', actions: ['pull'] }],
        allowed: [{ repository: 'gateway/source-1', actions: ['pull'] }],
      })
    ).toThrow('not allowed');
    expect(() =>
      service.issueToken({
        subject: 'runtime:node-1:deployment-1',
        requested: [{ repository: 'gateway/source-1', actions: ['push'] }],
        allowed: [{ repository: 'gateway/source-1', actions: ['pull'] }],
      })
    ).toThrow('not allowed');
  });

  it('keeps the signing identity stable across service restarts', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-registry-token-'));
    const first = new DockerRegistryTokenService(tempDir);
    await first.initialize();
    const certificate = first.getCertificatePem();
    const second = new DockerRegistryTokenService(tempDir);
    await second.initialize();
    expect(second.getCertificatePem()).toBe(certificate);
  });
});
