import { describe, expect, it } from 'vitest';
import { hasDockerPortBindIpV1Capability, hasRequestedSpecificPortBindIp } from './docker-port-bindings.js';

describe('docker port bind IP capability', () => {
  it('recognizes the advertised daemon capability', () => {
    expect(hasDockerPortBindIpV1Capability({ capabilities: ['docker_port_bind_ip_v1'] })).toBe(true);
    expect(hasDockerPortBindIpV1Capability({ capabilities: ['docker_archive_v1'] })).toBe(false);
  });

  it('requires the capability only for a specific publish address', () => {
    expect(hasRequestedSpecificPortBindIp({ ports: [{ hostIp: '0.0.0.0' }] })).toBe(false);
    expect(hasRequestedSpecificPortBindIp({ ports: [{ hostIp: '127.0.0.1' }] })).toBe(true);
    expect(hasRequestedSpecificPortBindIp({ ports: [{ hostIp: '192.168.1.20' }] })).toBe(true);
  });
});
