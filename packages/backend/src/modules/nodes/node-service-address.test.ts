import { describe, expect, it } from 'vitest';
import {
  getEffectiveNginxIngressAddress,
  getEffectiveNginxIngressAddresses,
  getEffectiveNodeServiceAddress,
  getEffectivePublishedNodeIP,
  getReportedPublicNodeAddresses,
  isPubliclyRoutableIp,
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

  it('uses the first local address for an automatic published endpoint', () => {
    expect(
      getEffectivePublishedNodeIP({
        serviceAddress: null,
        lastHealthReport: { localIpAddresses: ['172.18.0.2'], publicIpAddresses: ['203.0.113.10'] } as never,
      })
    ).toBe('172.18.0.2');
  });

  it('recognizes globally routable addresses and rejects private and reserved ranges', () => {
    expect(isPubliclyRoutableIp('1.1.1.1')).toBe(true);
    expect(isPubliclyRoutableIp('2606:4700:4700::1111')).toBe(true);
    expect(isPubliclyRoutableIp('2001:3::1')).toBe(true);
    expect(isPubliclyRoutableIp('2001:4:112::1')).toBe(true);
    expect(isPubliclyRoutableIp('2001:20::1')).toBe(true);
    expect(isPubliclyRoutableIp('2001:30::1')).toBe(true);
    expect(isPubliclyRoutableIp('10.0.0.8')).toBe(false);
    expect(isPubliclyRoutableIp('100.64.0.1')).toBe(false);
    expect(isPubliclyRoutableIp('203.0.113.10')).toBe(false);
    expect(isPubliclyRoutableIp('fd00::10')).toBe(false);
    expect(isPubliclyRoutableIp('2001:2::10')).toBe(false);
    expect(isPubliclyRoutableIp('2001:db8::10')).toBe(false);
    expect(isPubliclyRoutableIp('2002::10')).toBe(false);
    expect(isPubliclyRoutableIp('3fff::10')).toBe(false);
  });

  it('collects reported public addresses from both report fields in deterministic IP-family order', () => {
    expect(
      getReportedPublicNodeAddresses({
        lastHealthReport: {
          localIpAddresses: ['10.0.0.8', '8.8.8.8'],
          publicIpAddresses: ['2606:4700:4700::1111', '1.1.1.1', '8.8.8.8'],
        } as never,
      })
    ).toEqual(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']);
  });

  it('uses a detected or explicitly configured public address for Nginx ingress', () => {
    const report = {
      localIpAddresses: ['192.168.1.20'],
      publicIpAddresses: ['8.8.8.8', '1.1.1.1'],
    } as never;
    expect(getEffectiveNginxIngressAddress({ serviceAddress: null, lastHealthReport: report })).toBe('1.1.1.1');
    expect(getEffectiveNginxIngressAddress({ serviceAddress: '8.8.8.8', lastHealthReport: report })).toBe('8.8.8.8');
    expect(getEffectiveNginxIngressAddress({ serviceAddress: '9.9.9.9', lastHealthReport: report })).toBe('9.9.9.9');
    expect(getEffectiveNginxIngressAddress({ serviceAddress: '192.168.1.20', lastHealthReport: report })).toBeNull();
  });

  it('returns the configured secondary Nginx ingress address without enabling one automatically', () => {
    const report = {
      localIpAddresses: [],
      publicIpAddresses: ['8.8.8.8', '1.1.1.1'],
    } as never;

    expect(
      getEffectiveNginxIngressAddresses({
        serviceAddress: null,
        secondaryServiceAddress: null,
        lastHealthReport: report,
      })
    ).toEqual(['1.1.1.1']);
    expect(
      getEffectiveNginxIngressAddresses({
        serviceAddress: '8.8.8.8',
        secondaryServiceAddress: '9.9.9.9',
        lastHealthReport: report,
      })
    ).toEqual(['8.8.8.8', '9.9.9.9']);
  });

  it('returns every configured Nginx ingress address in its configured order', () => {
    expect(
      getEffectiveNginxIngressAddresses({
        serviceAddresses: ['9.9.9.9', '1.1.1.1', '8.8.8.8'],
        serviceAddress: '9.9.9.9',
        secondaryServiceAddress: '1.1.1.1',
        lastHealthReport: { publicIpAddresses: ['4.4.4.4'] } as never,
      })
    ).toEqual(['9.9.9.9', '1.1.1.1', '8.8.8.8']);
  });
});
