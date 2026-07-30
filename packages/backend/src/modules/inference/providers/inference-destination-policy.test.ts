import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { __testOnly, InferenceDestinationPolicy } from './inference-destination-policy.js';

describe('inference destination policy', () => {
  it('blocks metadata, link-local, private, loopback, and IPv6-local ranges by default', () => {
    for (const address of [
      '169.254.169.254',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '127.0.0.1',
      '::1',
      'fe80::1',
      'fd00::1',
    ]) {
      expect(() => __testOnly.assertAddress(address, false), address).toThrow(/blocked by network policy/);
    }
  });

  it('allows explicit private networks but never link-local or metadata ranges', () => {
    expect(() => __testOnly.assertAddress('10.0.0.1', true)).not.toThrow();
    expect(() => __testOnly.assertAddress('127.0.0.1', true)).not.toThrow();
    expect(() => __testOnly.assertAddress('fd00::1', true)).not.toThrow();
    expect(() => __testOnly.assertAddress('169.254.169.254', true)).toThrow();
    expect(() => __testOnly.assertAddress('fe80::1', true)).toThrow();
  });

  it('checks every DNS answer to prevent mixed-answer rebinding bypass', async () => {
    const resolver = vi.fn().mockResolvedValue([
      { address: '203.0.113.10', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    const policy = new InferenceDestinationPolicy(resolver);
    await expect(policy.assertAllowed('https://models.example.com/v1', false)).rejects.toMatchObject({
      code: 'INFERENCE_DESTINATION_BLOCKED',
    });
  });

  it('rejects a hostname that rebinds between validations', async () => {
    const resolver = vi
      .fn()
      .mockResolvedValueOnce([{ address: '203.0.113.10', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const policy = new InferenceDestinationPolicy(resolver);
    await expect(policy.assertAllowed('https://rebind.example/v1', false)).resolves.toMatchObject({
      address: '203.0.113.10',
    });
    await expect(policy.assertAllowed('https://rebind.example/v1', false)).rejects.toMatchObject({
      code: 'INFERENCE_DESTINATION_BLOCKED',
    });
  });

  it('rejects metadata hostnames and URL credentials before DNS', async () => {
    const resolver = vi.fn();
    const policy = new InferenceDestinationPolicy(resolver);
    await expect(policy.assertAllowed('http://metadata.google.internal/latest', true)).rejects.toMatchObject({
      code: 'INFERENCE_DESTINATION_BLOCKED',
    });
    await expect(policy.assertAllowed('https://user:secret@example.com/v1', false)).rejects.toMatchObject({
      code: 'INFERENCE_DESTINATION_INVALID',
    });
    expect(resolver).not.toHaveBeenCalled();
  });
});
