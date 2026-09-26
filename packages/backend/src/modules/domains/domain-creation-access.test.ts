import { describe, expect, it, vi } from 'vitest';
import {
  assertDomainIngressMoveAccess,
  canPickDomainNginxNode,
  domainNginxNodeOptionsForScopes,
  resolveDomainCreationNginxNodeId,
} from './domain-creation-access.js';

const TARGET = '22222222-2222-4222-8222-222222222222';
const FOLDER = '33333333-3333-4333-8333-333333333333';
const OTHER_FOLDER = '44444444-4444-4444-8444-444444444444';

describe('assertDomainIngressMoveAccess', () => {
  const host = { id: 'host-1', folderId: FOLDER };

  it('accepts the folder grant of each route for proxy:create on the target node', () => {
    expect(() =>
      assertDomainIngressMoveAccess([`proxy:create:folder/${FOLDER}`, 'proxy:edit:host-1'], TARGET, [host])
    ).not.toThrow();
  });

  it('accepts node-scoped and legacy bare-node proxy:create grants on the target', () => {
    expect(() =>
      assertDomainIngressMoveAccess([`proxy:create:node/${TARGET}`, 'proxy:edit'], TARGET, [host])
    ).not.toThrow();
    expect(() => assertDomainIngressMoveAccess([`proxy:create:${TARGET}`, 'proxy:edit'], TARGET, [host])).not.toThrow();
  });

  it('refuses a folder grant that does not cover the route and a missing route edit grant', () => {
    expect(() =>
      assertDomainIngressMoveAccess([`proxy:create:folder/${OTHER_FOLDER}`, 'proxy:edit'], TARGET, [host])
    ).toThrow(`Missing required scope: proxy:create:${TARGET}`);
    expect(() => assertDomainIngressMoveAccess([`proxy:create:node/${TARGET}`], TARGET, [host])).toThrow(
      'Missing required scope: proxy:edit:host-1'
    );
  });

  it('needs some proxy:create destination on the target for a domain without routes', () => {
    expect(() => assertDomainIngressMoveAccess([`proxy:create:folder/${FOLDER}`], TARGET, [])).not.toThrow();
    expect(() => assertDomainIngressMoveAccess(['proxy:edit'], TARGET, [])).toThrow(
      `Missing required scope: proxy:create:${TARGET}`
    );
  });
});

describe('domain creation node access', () => {
  const options = {
    eligibleNodes: [{ id: 'node-a' }, { id: 'node-b' }],
    unconfiguredNodes: [{ id: 'node-c' }],
    totalNginxNodes: 3,
    unconfiguredNginxNodes: 1,
  };

  it('lets broad and folder creators pick any node, even implicitly', () => {
    expect(canPickDomainNginxNode(['domains:create'], undefined)).toBe(true);
    expect(canPickDomainNginxNode([`domains:create:folder/${FOLDER}`], 'node-b')).toBe(true);
    expect(domainNginxNodeOptionsForScopes(options, [`domains:create:folder/${FOLDER}`])).toBe(options);
  });

  it('limits node-only creators to their named nodes', () => {
    const scopes = ['domains:create:node/node-a'];

    expect(canPickDomainNginxNode(scopes, 'node-a')).toBe(true);
    expect(canPickDomainNginxNode(scopes, 'node-b')).toBe(false);
    expect(canPickDomainNginxNode(scopes, undefined)).toBe(false);
    expect(domainNginxNodeOptionsForScopes(options, scopes)).toEqual({
      eligibleNodes: [{ id: 'node-a' }],
      unconfiguredNodes: [],
      totalNginxNodes: 1,
      unconfiguredNginxNodes: 0,
    });
  });
});

describe('resolveDomainCreationNginxNodeId', () => {
  const NODE_A = '55555555-5555-4555-8555-555555555555';
  const NODE_B = '66666666-6666-4666-8666-666666666666';
  const eligibleNodes = [
    { id: NODE_A, hostname: 'edge-a', displayName: 'Edge A' },
    { id: NODE_B, hostname: 'edge-b', displayName: null },
  ];
  const load = () => vi.fn().mockResolvedValue({ eligibleNodes });

  it('keeps an explicit node and leaves the choice to the service for broad and destination-folder grants', async () => {
    const options = load();
    await expect(
      resolveDomainCreationNginxNodeId(['domains:create:node/x'], { nginxNodeId: NODE_B }, options)
    ).resolves.toBe(NODE_B);
    await expect(resolveDomainCreationNginxNodeId(['domains:create'], {}, options)).resolves.toBeUndefined();
    await expect(
      resolveDomainCreationNginxNodeId([`domains:create:folder/${FOLDER}`], { folderId: FOLDER }, options)
    ).resolves.toBeUndefined();
    // A folder grant without its folder cannot create at the root: the destination check refuses.
    await expect(
      resolveDomainCreationNginxNodeId([`domains:create:folder/${FOLDER}`], {}, options)
    ).resolves.toBeUndefined();
    expect(options).not.toHaveBeenCalled();
  });

  it('gives a node-limited creator its only granted node with a public address', async () => {
    await expect(resolveDomainCreationNginxNodeId([`domains:create:node/${NODE_B}`], {}, load())).resolves.toBe(NODE_B);
    await expect(resolveDomainCreationNginxNodeId([`domains:create:${NODE_A}`], {}, load())).resolves.toBe(NODE_A);
    await expect(
      resolveDomainCreationNginxNodeId(['domains:create:node/99999999-9999-4999-8999-999999999999'], {}, load())
    ).resolves.toBeUndefined();
  });

  it('refuses a node-limited creator with several granted nodes and lists them', async () => {
    await expect(
      resolveDomainCreationNginxNodeId([`domains:create:node/${NODE_A}`, `domains:create:node/${NODE_B}`], {}, load())
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'DOMAIN_NGINX_NODE_REQUIRED',
      message: expect.stringContaining(`Edge A (edge-a): ${NODE_A}; edge-b: ${NODE_B}`),
      details: {
        eligibleNodes: [
          { id: NODE_A, hostname: 'edge-a', displayName: 'Edge A' },
          { id: NODE_B, hostname: 'edge-b', displayName: null },
        ],
      },
    });
  });
});
