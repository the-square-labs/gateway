import { describe, expect, it } from 'vitest';
import {
  type RouteIngressNodeCandidate,
  resolveRouteIngressNode,
  routeIngressNodesForScopes,
} from './route-ingress-nodes.js';

function node(id: string, status: RouteIngressNodeCandidate['status']): RouteIngressNodeCandidate {
  return { id, displayName: null, hostname: `${id}.example`, status, serviceCreationLocked: false };
}

describe('Route ingress nodes', () => {
  it('places a route without nodeId on the only connected node when another node is still pending', () => {
    const candidates = [node('ingress-1', 'online'), node('never-connected', 'pending')];

    expect(routeIngressNodesForScopes(candidates, ['proxy:create']).map((candidate) => candidate.id)).toEqual([
      'ingress-1',
    ]);
    expect(resolveRouteIngressNode({ scopes: ['proxy:create'], pinnedNodeId: null, candidates })).toEqual({
      nodeId: 'ingress-1',
      source: 'single_eligible',
    });
  });

  it('still asks for nodeId when two enrolled nodes qualify', () => {
    const candidates = [node('ingress-1', 'online'), node('ingress-2', 'offline'), node('test', 'pending')];

    expect(() => resolveRouteIngressNode({ scopes: ['proxy:create'], pinnedNodeId: null, candidates })).toThrow(
      expect.objectContaining({
        code: 'ROUTE_INGRESS_NODE_REQUIRED',
        details: {
          eligibleNodes: [expect.objectContaining({ id: 'ingress-1' }), expect.objectContaining({ id: 'ingress-2' })],
        },
      })
    );
  });
});
