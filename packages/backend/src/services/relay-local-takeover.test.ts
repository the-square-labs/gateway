import { describe, expect, it } from 'vitest';
import { candidateAssignmentState, drainingTunnels, LOCAL_RELAY_DRAIN_CAPABILITY } from './relay-local-takeover.js';

describe('drainingTunnels', () => {
  const health = {
    activeTunnels: 5,
    assignmentTunnels: [
      { endpointId: 'endpoint-registry', activeTunnels: 3 },
      { endpointId: 'endpoint-database', activeTunnels: 2 },
    ],
  };

  it('counts every tunnel of a drained relay', () => {
    expect(drainingTunnels(health)).toBe(5);
    expect(drainingTunnels(null)).toBe(0);
  });

  it('leaves out the tunnels the draining relay keeps admitting', () => {
    expect(drainingTunnels(health, new Set(['endpoint-registry']))).toBe(2);
    expect(drainingTunnels({ ...health, activeTunnels: 3 }, new Set(['endpoint-registry']))).toBe(0);
  });
});

describe('candidateAssignmentState', () => {
  const drainedLocal = { state: 'active' as const, instanceState: 'draining', kind: 'local' as const };
  const capable = ['relay_pool_v1', LOCAL_RELAY_DRAIN_CAPABILITY];

  it('keeps the draining local relay a usable candidate for the internal registry (stand rc.20)', () => {
    expect(candidateAssignmentState(drainedLocal, 'local_service', capable)).toBe('active');
  });

  it('marks every other candidate of a draining relay draining', () => {
    expect(candidateAssignmentState(drainedLocal, 'daemon', capable)).toBe('draining');
    expect(candidateAssignmentState({ ...drainedLocal, kind: 'remote' }, 'local_service', capable)).toBe('draining');
    // A local relay that refuses local-service tunnels while it drains is no candidate for them either.
    expect(candidateAssignmentState(drainedLocal, 'local_service', ['relay_pool_v1'])).toBe('draining');
    expect(candidateAssignmentState({ ...drainedLocal, instanceState: 'ready', state: 'staging' }, 'daemon', [])).toBe(
      'staging'
    );
  });
});
