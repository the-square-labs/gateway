import { describe, expect, it, vi } from 'vitest';
import {
  availabilityMemberBindingFields,
  availabilityMemberSyncContext,
  syncableAvailabilityMember,
} from './proxy-secure-link-availability.js';

const PLACEMENT_ID = '11111111-1111-4111-8111-111111111111';
const POLICY_ID = '22222222-2222-4222-8222-222222222222';
const DOCKER_NODE_ID = '33333333-3333-4333-8333-333333333333';

function link(extra: Record<string, unknown> = {}) {
  return {
    id: 'link',
    purpose: 'availability_member',
    referenceId: PLACEMENT_ID,
    dockerNodeId: DOCKER_NODE_ID,
    dormant: false,
    ...extra,
  } as never;
}

function db(capabilities: string[], leasePolicies: string[] = [POLICY_ID]) {
  const results = [
    [{ capabilities: { capabilities } }],
    [{ id: PLACEMENT_ID, policyId: POLICY_ID }],
    leasePolicies.map((policyId) => ({ policyId })),
  ];
  const query = () => {
    const rows = results.shift() ?? [];
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'where']) chain[method] = () => chain;
    chain.limit = async () => rows;
    // biome-ignore lint/suspicious/noThenProperty: emulate Drizzle's lazy thenable query
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
    return chain;
  };
  return { select: vi.fn(query) } as never;
}

describe('Availability member secure-link sync (D7, D8)', () => {
  it('describes members with their lease policy and candidate, and keeps dormant ones from old daemons', async () => {
    const capable = await availabilityMemberSyncContext(db(['availability_lease_v1']), 'nginx', [link()]);
    expect(capable.leaseCapable).toBe(true);
    expect(availabilityMemberBindingFields(link({ dormant: true }), capable)).toEqual({
      dormant: true,
      availabilityPolicyId: POLICY_ID,
      availabilityCandidateId: DOCKER_NODE_ID,
    });
    expect(syncableAvailabilityMember(link({ dormant: true }), capable)).toBe(true);

    const old = await availabilityMemberSyncContext(db(['proxy_secure_links_v1']), 'nginx', [link()]);
    expect(syncableAvailabilityMember(link({ dormant: true }), old)).toBe(false);
    expect(syncableAvailabilityMember(link(), old)).toBe(true);
  });

  it('sends every lease-mode member dormant, so a stopped holder container never fails the target sync', async () => {
    // Stand run ha18/b: the failback marked the successor's member live before its container started; the target
    // daemon rejected the set and the member was dropped from the node for 11 minutes.
    const capable = await availabilityMemberSyncContext(db(['availability_lease_v1']), 'docker', [link()]);
    expect(availabilityMemberBindingFields(link({ dormant: false }), capable)).toEqual({
      dormant: true,
      availabilityPolicyId: POLICY_ID,
      availabilityCandidateId: DOCKER_NODE_ID,
    });
  });

  it('gates members by the lease only while their policy is in lease mode (B2)', async () => {
    const legacy = await availabilityMemberSyncContext(db(['availability_lease_v1'], []), 'nginx', [link()]);
    expect(availabilityMemberBindingFields(link(), legacy)).toEqual({ dormant: false });
    expect(availabilityMemberBindingFields(link({ dormant: true }), legacy)).toEqual({ dormant: true });
  });

  it('adds nothing to other bindings and queries nothing without Availability members', async () => {
    const database = db([]);
    const context = await availabilityMemberSyncContext(database, 'nginx', [link({ purpose: 'user_managed' })]);
    expect((database as unknown as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
    expect(availabilityMemberBindingFields(link({ purpose: 'user_managed' }), context)).toEqual({});
  });
});
