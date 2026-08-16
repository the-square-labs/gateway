import { beforeEach, describe, expect, it } from 'vitest';
import type { DnsRecords } from '@/db/schema/domains.js';
import { computeDnsStatus, detectPublicIP, dnsProbeName } from './dns.utils.js';

function makeRecords(overrides?: Partial<DnsRecords>): DnsRecords {
  return {
    a: [],
    aaaa: [],
    cname: [],
    caa: [],
    mx: [],
    txt: [],
    ...overrides,
  };
}

describe('computeDnsStatus', () => {
  beforeEach(async () => {
    await detectPublicIP('198.51.100.10', '2001:db8::10');
  });

  it('marks DNS valid when records match any configured IPv4', async () => {
    await detectPublicIP('198.51.100.10,198.51.100.11', '2001:db8::10');

    const status = computeDnsStatus(
      makeRecords({
        a: ['198.51.100.11'],
      })
    );

    expect(status).toBe('valid');
  });

  it('marks DNS valid when records match any configured IPv6', async () => {
    await detectPublicIP('198.51.100.10', '2001:db8::10,2001:db8::11');

    const status = computeDnsStatus(
      makeRecords({
        aaaa: ['2001:db8::11'],
      })
    );

    expect(status).toBe('valid');
  });

  it('keeps DNS invalid when records point elsewhere', () => {
    const status = computeDnsStatus(
      makeRecords({
        a: ['203.0.113.10'],
      })
    );

    expect(status).toBe('invalid');
  });
});

describe('dnsProbeName', () => {
  it('checks exact domains directly', () => {
    expect(dnsProbeName('App.Example.com', 'fixed')).toBe('app.example.com');
  });

  it('checks wildcard DNS through a random child inside the wildcard', () => {
    expect(dnsProbeName('*.Example.com', 'fixed')).toBe('_gateway-check-fixed.example.com');
  });
});
