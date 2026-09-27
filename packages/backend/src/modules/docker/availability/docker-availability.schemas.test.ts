import { describe, expect, it } from 'vitest';
import {
  DockerAvailabilityPolicyInputSchema,
  DockerAvailabilityPolicyUpdateSchema,
} from './docker-availability.schemas.js';

const GOOD = '11111111-1111-4111-8111-111111111111';
const WEAK = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

const base = {
  resource: { type: 'deployment', deploymentId: '44444444-4444-4444-8444-444444444444' },
  mode: 'failover',
  desiredReplicaCount: 1,
  nodeSelectionMode: 'selected',
  selectedNodeIds: [GOOD, WEAK],
};

function issuePaths(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }) {
  return result.success ? [] : (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
}

describe('Availability priority mode input', () => {
  it('defaults to priority mode off with a five-minute failback delay', () => {
    const parsed = DockerAvailabilityPolicyInputSchema.parse(base);
    expect(parsed).toMatchObject({ priorityMode: false, nodePriority: [], failbackDelaySeconds: 300 });
  });

  it('accepts an ordered list of selected nodes', () => {
    const parsed = DockerAvailabilityPolicyInputSchema.parse({
      ...base,
      priorityMode: true,
      nodePriority: [WEAK, GOOD],
      failbackDelaySeconds: 0,
    });
    expect(parsed.nodePriority).toEqual([WEAK, GOOD]);
  });

  it('rejects duplicates, a missing primary, unselected nodes and an out-of-range delay', () => {
    expect(
      issuePaths(
        DockerAvailabilityPolicyInputSchema.safeParse({ ...base, priorityMode: true, nodePriority: [GOOD, GOOD] })
      )
    ).toContain('nodePriority');
    expect(
      issuePaths(DockerAvailabilityPolicyInputSchema.safeParse({ ...base, priorityMode: true, nodePriority: [] }))
    ).toContain('nodePriority');
    expect(
      issuePaths(
        DockerAvailabilityPolicyInputSchema.safeParse({ ...base, priorityMode: true, nodePriority: [GOOD, OTHER] })
      )
    ).toContain('nodePriority');
    expect(
      issuePaths(DockerAvailabilityPolicyInputSchema.safeParse({ ...base, failbackDelaySeconds: 3601 }))
    ).toContain('failbackDelaySeconds');
  });

  it('validates partial updates that change the order', () => {
    expect(DockerAvailabilityPolicyUpdateSchema.safeParse({ priorityMode: true }).success).toBe(true);
    expect(
      issuePaths(DockerAvailabilityPolicyUpdateSchema.safeParse({ priorityMode: true, nodePriority: [] }))
    ).toContain('nodePriority');
    expect(
      issuePaths(
        DockerAvailabilityPolicyUpdateSchema.safeParse({
          priorityMode: true,
          nodeSelectionMode: 'selected',
          selectedNodeIds: [GOOD],
          nodePriority: [WEAK],
        })
      )
    ).toContain('nodePriority');
    expect(
      DockerAvailabilityPolicyUpdateSchema.safeParse({
        priorityMode: false,
        nodeSelectionMode: 'selected',
        selectedNodeIds: [GOOD],
        nodePriority: [WEAK],
      }).success
    ).toBe(true);
  });
});
