import { describe, expect, it, vi } from 'vitest';
import { discoverPublicIpAddresses, isPublicIpAddress } from './public-ip-detector.js';

describe('discoverPublicIpAddresses', () => {
  it('runs the full sample window even when every provider initially sees the same address', async () => {
    const fetchAddress = vi.fn(async () => '8.8.8.8');

    await expect(discoverPublicIpAddresses(fetchAddress, ['one', 'two', 'three'])).resolves.toEqual(['8.8.8.8']);
    expect(fetchAddress).toHaveBeenCalledTimes(30);
  });

  it('collects balanced NAT egress addresses across the full sample window', async () => {
    let calls = 0;
    const fetchAddress = vi.fn(async () => {
      calls += 1;
      return calls % 2 === 0 ? '1.1.1.1' : '8.8.8.8';
    });

    await expect(discoverPublicIpAddresses(fetchAddress, ['one', 'two', 'three'])).resolves.toEqual([
      '1.1.1.1',
      '8.8.8.8',
    ]);
    expect(fetchAddress).toHaveBeenCalledTimes(30);
  });

  it('ignores failed providers and non-public responses', async () => {
    const fetchAddress = vi.fn(async (provider: string) => {
      if (provider === 'failed') throw new Error('offline');
      return provider === 'private' ? '10.0.0.10' : '2001:4860:4860::8888';
    });

    await expect(discoverPublicIpAddresses(fetchAddress, ['failed', 'private', 'public'])).resolves.toEqual([
      '2001:4860:4860::8888',
    ]);
    expect(fetchAddress).toHaveBeenCalledTimes(30);
  });
});

describe('isPublicIpAddress', () => {
  it.each([
    ['8.8.8.8', true],
    ['2001:4860:4860::8888', true],
    ['10.0.0.1', false],
    ['100.64.0.1', false],
    ['169.254.10.1', false],
    ['192.0.2.10', false],
    ['198.51.100.10', false],
    ['203.0.113.10', false],
    ['127.0.0.1', false],
    ['fd00::1', false],
    ['fe80::1', false],
    ['2001:db8::10', false],
  ])('classifies %s as public=%s', (address, expected) => {
    expect(isPublicIpAddress(address)).toBe(expected);
  });
});
