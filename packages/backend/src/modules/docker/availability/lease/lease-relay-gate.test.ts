import { describe, expect, it } from 'vitest';
import {
  containerLinkPlacements,
  dockerAvailabilityLeaseState,
  managedDatabaseBindingPlacements,
  proxyAdditionalSecureLinks,
} from '@/db/schema/index.js';
import { relayLeasePolicyIds } from './lease-relay-gate.js';

const TARGET_LEASE = '11111111-1111-4111-8111-111111111111';
const TARGET_LEGACY = '22222222-2222-4222-8222-222222222222';
const LINK = '33333333-3333-4333-8333-333333333333';

/** Every read of a table answers its rows, whatever the query shape. */
function fakeDb(rows: Map<unknown, unknown[]>) {
  return {
    select: () => ({
      from: (table: unknown) => {
        const query = Promise.resolve(rows.get(table) ?? []) as Promise<unknown[]> & Record<string, unknown>;
        query.innerJoin = () => query;
        query.where = () => query;
        return query;
      },
    }),
  } as never;
}

describe('relay lease gate of container link targets', () => {
  it('gates the endpoint of every target placement of a policy in lease mode, and nothing else', async () => {
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [dockerAvailabilityLeaseState, [{ policyId: 'policy-lease' }]],
        [
          containerLinkPlacements,
          [
            { ownerId: TARGET_LEASE, policyId: 'policy-lease' },
            { ownerId: TARGET_LEGACY, policyId: 'policy-legacy' },
          ],
        ],
        [proxyAdditionalSecureLinks, []],
        [managedDatabaseBindingPlacements, []],
      ])
    );

    const gated = await relayLeasePolicyIds(
      db,
      [
        { id: 'endpoint-lease', ownerKind: 'container_link', ownerId: TARGET_LEASE },
        { id: 'endpoint-legacy', ownerKind: 'container_link', ownerId: TARGET_LEGACY },
        // A single-node target is served by the link's own endpoint: it is not a placement.
        { id: 'endpoint-link', ownerKind: 'container_link', ownerId: LINK },
      ],
      []
    );

    expect([...gated.endpoints]).toEqual([['endpoint-lease', 'policy-lease']]);
    expect(gated.routes.size).toBe(0);
  });
});
