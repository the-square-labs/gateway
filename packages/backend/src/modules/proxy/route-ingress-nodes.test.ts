import { describe, expect, it } from 'vitest';
import { registeredDomainsIngressNodeId } from './proxy-domain-node.js';
import {
  type RouteIngressNodeCandidate,
  resolveRouteIngressNode,
  routeIngressNodesForScopes,
} from './route-ingress-nodes.js';

const EDGE_1 = '11111111-1111-4111-8111-111111111111';
const EDGE_2 = '22222222-2222-4222-8222-222222222222';
const LOCKED = '33333333-3333-4333-8333-333333333333';
const FOLDER = '44444444-4444-4444-8444-444444444444';
const OTHER_FOLDER = '55555555-5555-4555-8555-555555555555';

const NODES: RouteIngressNodeCandidate[] = [
  { id: EDGE_1, displayName: 'Edge One', hostname: 'edge-1', status: 'online', serviceCreationLocked: false },
  { id: EDGE_2, displayName: null, hostname: 'edge-2', status: 'offline', serviceCreationLocked: false },
  { id: LOCKED, displayName: 'Locked', hostname: 'edge-3', status: 'online', serviceCreationLocked: true },
];

const ids = (nodes: Array<{ id: string }>) => nodes.map((node) => node.id);

describe('routeIngressNodesForScopes', () => {
  it('offers every open node to a broad grant and never a node locked for new services', () => {
    expect(ids(routeIngressNodesForScopes(NODES, ['proxy:create']))).toEqual([EDGE_1, EDGE_2]);
    expect(ids(routeIngressNodesForScopes(NODES, ['proxy:create'], null))).toEqual([EDGE_1, EDGE_2]);
    expect(ids(routeIngressNodesForScopes(NODES, ['proxy:create'], FOLDER))).toEqual([EDGE_1, EDGE_2]);
  });

  it('offers every node to a folder grant, and only for a route in that folder when one is named', () => {
    const scopes = [`proxy:create:folder/${FOLDER}`];
    expect(ids(routeIngressNodesForScopes(NODES, scopes))).toEqual([EDGE_1, EDGE_2]);
    expect(ids(routeIngressNodesForScopes(NODES, scopes, FOLDER))).toEqual([EDGE_1, EDGE_2]);
    expect(routeIngressNodesForScopes(NODES, scopes, OTHER_FOLDER)).toEqual([]);
    expect(routeIngressNodesForScopes(NODES, scopes, null)).toEqual([]);
  });

  it('offers node grants only their nodes, in the node/<id> and legacy bare forms', () => {
    expect(ids(routeIngressNodesForScopes(NODES, [`proxy:create:node/${EDGE_2}`]))).toEqual([EDGE_2]);
    expect(ids(routeIngressNodesForScopes(NODES, [`proxy:create:${EDGE_1}`], FOLDER))).toEqual([EDGE_1]);
    expect(routeIngressNodesForScopes(NODES, [`proxy:create:node/${LOCKED}`])).toEqual([]);
  });

  it('offers nothing without a proxy:create grant', () => {
    expect(routeIngressNodesForScopes(NODES, ['proxy:view', 'nodes:details'])).toEqual([]);
  });
});

describe('registeredDomainsIngressNodeId', () => {
  it('returns the node every registered domain shares, or null without registered domains', () => {
    expect(registeredDomainsIngressNodeId([])).toBeNull();
    expect(
      registeredDomainsIngressNodeId([
        { domain: 'example.com', nginxNodeId: EDGE_2 },
        { domain: '*.example.com', nginxNodeId: EDGE_2 },
      ])
    ).toBe(EDGE_2);
  });

  it('refuses registered domains on different or unresolved nodes', () => {
    expect(() =>
      registeredDomainsIngressNodeId([
        { domain: 'a.example.com', nginxNodeId: EDGE_1 },
        { domain: 'b.example.com', nginxNodeId: EDGE_2 },
      ])
    ).toThrow(expect.objectContaining({ statusCode: 409, code: 'DOMAIN_NGINX_NODE_MISMATCH' }));
    expect(() => registeredDomainsIngressNodeId([{ domain: 'a.example.com', nginxNodeId: null }])).toThrow(
      expect.objectContaining({ statusCode: 409, code: 'DOMAIN_NGINX_NODE_MISMATCH' })
    );
  });
});

describe('resolveRouteIngressNode', () => {
  it('uses the node a registered domain pins for a creator allowed there', () => {
    for (const scopes of [['proxy:create'], [`proxy:create:node/${EDGE_2}`], [`proxy:create:${EDGE_2}`]]) {
      expect(resolveRouteIngressNode({ scopes, pinnedNodeId: EDGE_2, candidates: NODES })).toEqual({
        nodeId: EDGE_2,
        source: 'domain',
      });
    }
    expect(
      resolveRouteIngressNode({
        scopes: [`proxy:create:folder/${FOLDER}`],
        folderId: FOLDER,
        pinnedNodeId: EDGE_2,
        candidates: NODES,
      })
    ).toEqual({ nodeId: EDGE_2, source: 'domain' });
  });

  it('refuses a pinned node outside the grant and names the node and scope', () => {
    const refuse = (scopes: string[], folderId?: string) =>
      resolveRouteIngressNode({
        scopes,
        folderId,
        pinnedNodeId: EDGE_2,
        pinnedByDomain: 'app.example.com',
        candidates: NODES,
      });
    for (const [scopes, folderId] of [
      [[`proxy:create:node/${EDGE_1}`], undefined],
      [[`proxy:create:folder/${FOLDER}`], undefined],
      [[`proxy:create:folder/${FOLDER}`], OTHER_FOLDER],
    ] as const) {
      expect(() => refuse([...scopes], folderId)).toThrow(
        expect.objectContaining({
          statusCode: 403,
          message: expect.stringContaining(`app.example.com is served by Nginx ingress node ${EDGE_2}`),
          details: expect.objectContaining({ requiredScope: `proxy:create:node/${EDGE_2}` }),
        })
      );
    }
  });

  it('uses the only node the caller may create on when no registered domain pins one', () => {
    expect(
      resolveRouteIngressNode({ scopes: [`proxy:create:node/${EDGE_1}`], pinnedNodeId: null, candidates: NODES })
    ).toEqual({ nodeId: EDGE_1, source: 'single_eligible' });
  });

  it('never picks a disconnected node automatically', () => {
    expect(() =>
      resolveRouteIngressNode({ scopes: ['proxy:create'], pinnedNodeId: null, candidates: [NODES[1]!, NODES[2]!] })
    ).toThrow(
      expect.objectContaining({
        statusCode: 409,
        code: 'ROUTE_INGRESS_NODE_REQUIRED',
        message: expect.stringContaining('is not connected'),
      })
    );
  });

  it('refuses with the eligible nodes listed when several qualify', () => {
    let error: unknown;
    try {
      resolveRouteIngressNode({ scopes: ['proxy:create'], pinnedNodeId: null, candidates: NODES });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      statusCode: 409,
      code: 'ROUTE_INGRESS_NODE_REQUIRED',
      details: {
        eligibleNodes: [
          { id: EDGE_1, displayName: 'Edge One', hostname: 'edge-1', status: 'online' },
          { id: EDGE_2, displayName: null, hostname: 'edge-2', status: 'offline' },
        ],
      },
    });
    const message = (error as Error).message;
    expect(message).toContain('Pass nodeId with one of');
    expect(message).toContain(`Edge One (edge-1): ${EDGE_1}, online`);
    expect(message).toContain(`edge-2: ${EDGE_2}, offline`);
    expect(message).not.toContain(LOCKED);
  });

  it('refuses a destination the caller cannot create at, and reports when no node is open', () => {
    expect(() =>
      resolveRouteIngressNode({ scopes: [`proxy:create:folder/${FOLDER}`], pinnedNodeId: null, candidates: NODES })
    ).toThrow(expect.objectContaining({ statusCode: 403, message: expect.stringContaining('selected destination') }));
    expect(() =>
      resolveRouteIngressNode({ scopes: [`proxy:create:node/${LOCKED}`], pinnedNodeId: null, candidates: NODES })
    ).toThrow(expect.objectContaining({ statusCode: 409, code: 'ROUTE_INGRESS_NODE_UNAVAILABLE' }));
    expect(() => resolveRouteIngressNode({ scopes: ['proxy:create'], pinnedNodeId: null, candidates: [] })).toThrow(
      expect.objectContaining({ statusCode: 409, code: 'ROUTE_INGRESS_NODE_UNAVAILABLE' })
    );
  });
});
