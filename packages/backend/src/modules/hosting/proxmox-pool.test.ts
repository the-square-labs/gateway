import { describe, expect, it } from 'vitest';
import { parseIpv4Range, parseVmidRange } from './proxmox-pool.js';

describe('Proxmox allocation pools', () => {
  it('rejects network and broadcast addresses in high-bit IPv4 subnets', () => {
    expect(() => parseIpv4Range('192.0.2.0', '192.0.2.0/24', '192.0.2.1')).toThrow('usable host addresses');
    expect(() => parseIpv4Range('192.0.2.255', '192.0.2.0/24', '192.0.2.1')).toThrow('usable host addresses');
    expect(parseIpv4Range('192.0.2.2-192.0.2.3', '192.0.2.0/24', '192.0.2.1').ips).toEqual(['192.0.2.2', '192.0.2.3']);
  });

  it('caps the deduplicated VMID union rather than rejecting overlapping valid ranges', () => {
    const parsed = parseVmidRange('100-1099,100-1099');
    expect(parsed.ids).toHaveLength(1000);
    expect(parsed.normalized).toBe('100-1099');
  });
});
