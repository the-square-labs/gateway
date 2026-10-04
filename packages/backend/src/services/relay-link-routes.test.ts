import { describe, expect, it } from 'vitest';
import { routeTransportRestartRequired } from './relay-link-routes.js';

const listener = { networkName: 'gateway-db-a', listenAddress: '172.30.0.1', listenPort: 5432, allowedSources: [] };
const egress = { networkName: 'gateway-db-a', alias: 'db-a', listenPort: 5432, maxSessions: 16 };
const transport = (managedDatabaseListener: typeof listener | null, secureLinkEgress: typeof egress | null) => ({
  managedDatabaseListener,
  secureLinkEgress,
});

describe('link route transport changes (D8, D9)', () => {
  it('keeps the route and its tunnels while one entry point serves through a migration and its revert', () => {
    // Database migration: egress added next to the listener, then the listener goes.
    expect(routeTransportRestartRequired(transport(listener, null), transport(listener, egress))).toBe(false);
    expect(routeTransportRestartRequired(transport(listener, egress), transport(null, egress))).toBe(false);
    // Revert: the listener comes back next to the egress, then the egress goes.
    expect(routeTransportRestartRequired(transport(null, egress), transport(listener, egress))).toBe(false);
    expect(routeTransportRestartRequired(transport(listener, egress), transport(listener, null))).toBe(false);
    // A storage route its sidecar serves gains or loses the connector egress.
    expect(routeTransportRestartRequired(transport(null, null), transport(null, egress))).toBe(false);
    expect(routeTransportRestartRequired(transport(null, egress), transport(null, null))).toBe(false);
  });

  it('restarts the route when a serving entry point changes or the only listener comes or goes', () => {
    expect(
      routeTransportRestartRequired(
        transport(listener, null),
        transport({ ...listener, listenAddress: '172.30.0.9' }, null)
      )
    ).toBe(true);
    expect(routeTransportRestartRequired(transport(null, egress), transport(null, { ...egress, alias: 'db-b' }))).toBe(
      true
    );
    expect(routeTransportRestartRequired(transport(listener, null), transport(null, null))).toBe(true);
    expect(routeTransportRestartRequired(transport(null, null), transport(listener, null))).toBe(true);
    // Only the admitted workloads changed: the listener is updated in place.
    expect(
      routeTransportRestartRequired(
        transport(listener, null),
        transport({ ...listener, allowedSources: ['container:x'] }, null)
      )
    ).toBe(false);
  });
});
