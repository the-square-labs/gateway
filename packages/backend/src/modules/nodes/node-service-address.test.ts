import { describe, expect, it } from 'vitest';
import {
  getEffectiveNodeServiceAddress,
  getEffectivePublishedNodeIP,
  isValidNodeServiceAddress,
} from './node-service-address.js';

describe('node service address', () => {
  it('uses an explicit override before reported local addresses', () => {
    expect(
      getEffectiveNodeServiceAddress({
        serviceAddress: 'docker.internal',
        lastHealthReport: { localIpAddresses: ['10.0.0.10'] } as never,
      })
    ).toBe('docker.internal');
  });

  it('uses the first reported local address when no override exists', () => {
    expect(
      getEffectiveNodeServiceAddress({
        serviceAddress: null,
        lastHealthReport: { localIpAddresses: ['192.168.1.20', '10.0.0.8'] } as never,
      })
    ).toBe('192.168.1.20');
  });

  it('falls back to the first reported public address when no local address exists', () => {
    expect(
      getEffectiveNodeServiceAddress({
        serviceAddress: null,
        lastHealthReport: { localIpAddresses: [], publicIpAddresses: ['8.8.8.8'] } as never,
      })
    ).toBe('8.8.8.8');
  });

  it('accepts IP addresses and hostnames but rejects URLs', () => {
    expect(isValidNodeServiceAddress('10.0.0.8')).toBe(true);
    expect(isValidNodeServiceAddress('fd00::10')).toBe(true);
    expect(isValidNodeServiceAddress('docker-node.internal')).toBe(true);
    expect(isValidNodeServiceAddress('http://docker-node.internal')).toBe(false);
  });

  it('uses a certificate-covered published IP instead of a hostname override', () => {
    expect(
      getEffectivePublishedNodeIP({
        serviceAddress: 'database.example.test',
        lastHealthReport: { localIpAddresses: ['10.0.0.8'], publicIpAddresses: ['203.0.113.10'] } as never,
      })
    ).toBe('203.0.113.10');
  });
});
