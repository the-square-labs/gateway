import { describe, expect, it } from 'vitest';
import {
  assertDomainIngressMoveAccess,
  canPickDomainNginxNode,
  domainNginxNodeOptionsForScopes,
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
