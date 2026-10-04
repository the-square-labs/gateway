import { describe, expect, it } from 'vitest';
import { reportedRelayServiceEndpoint, requestedRelayServicePort } from './relay-service-endpoint.js';

describe('relay service endpoint', () => {
  it('keeps the port a relay node was created with until it enrolls', () => {
    expect(requestedRelayServicePort({ createdById: 'user-1', relayServicePort: 853 })).toBe(853);
    expect(requestedRelayServicePort({ createdById: 'user-1' })).toBe(9443);
    expect(requestedRelayServicePort({ relayServicePort: 70000 })).toBe(9443);
    expect(requestedRelayServicePort(null)).toBe(9443);
  });

  it('moves a relay to the port its worker reports listening on', () => {
    expect(
      reportedRelayServiceEndpoint(
        { servicePort: 9443, advertisedAddresses: ['203.0.113.10'] },
        { servicePort: 853, advertisedAddresses: ['203.0.113.10'] }
      )
    ).toEqual({ servicePort: 853, advertisedAddresses: ['203.0.113.10'] });
  });

  it('changes nothing while the report matches the relay', () => {
    expect(
      reportedRelayServiceEndpoint(
        { servicePort: 853, advertisedAddresses: ['203.0.113.10'] },
        { servicePort: 853, advertisedAddresses: ['203.0.113.10'] }
      )
    ).toBeNull();
  });

  it('ignores a report without a port or with an invalid one', () => {
    const current = { servicePort: 853, advertisedAddresses: ['203.0.113.10'] };
    expect(reportedRelayServiceEndpoint(current, { servicePort: 0, advertisedAddresses: [] })).toBeNull();
    expect(reportedRelayServiceEndpoint(current, { servicePort: 70000 })).toBeNull();
  });

  it('keeps the addresses an operator listed beyond the one the installer advertised', () => {
    expect(
      reportedRelayServiceEndpoint(
        { servicePort: 9443, advertisedAddresses: ['203.0.113.10', 'relay.example.com'] },
        { servicePort: 9443, advertisedAddresses: ['203.0.113.10'] }
      )
    ).toBeNull();
  });

  it('takes the reported addresses when the relay was installed again with another address', () => {
    expect(
      reportedRelayServiceEndpoint(
        { servicePort: 9443, advertisedAddresses: ['203.0.113.10', 'relay.example.com'] },
        { servicePort: 9444, advertisedAddresses: ['203.0.113.20'] }
      )
    ).toEqual({ servicePort: 9444, advertisedAddresses: ['203.0.113.20'] });
    // An address that is not an IP address or hostname is not taken over.
    expect(
      reportedRelayServiceEndpoint(
        { servicePort: 9443, advertisedAddresses: ['203.0.113.10'] },
        { servicePort: 9443, advertisedAddresses: ['not an address'] }
      )
    ).toBeNull();
  });
});
