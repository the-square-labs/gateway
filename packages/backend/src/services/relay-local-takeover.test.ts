import { describe, expect, it } from 'vitest';
import { drainingTunnels } from './relay-local-takeover.js';

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
