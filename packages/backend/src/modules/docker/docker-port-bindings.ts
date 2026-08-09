const PORT_BIND_IP_CAPABILITY = 'docker_port_bind_ip_v1';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function hasDockerPortBindIpV1Capability(value: unknown): boolean {
  const capabilities = record(value);
  if (!capabilities) return false;
  if (capabilities.dockerPortBindIpV1 === true || capabilities.docker_port_bind_ip_v1 === true) return true;
  return Array.isArray(capabilities.capabilities) && capabilities.capabilities.includes(PORT_BIND_IP_CAPABILITY);
}

export function hasRequestedSpecificPortBindIp(config: Record<string, unknown>): boolean {
  if (!Array.isArray(config.ports)) return false;
  return config.ports.some((port) => {
    const hostIp = record(port)?.hostIp;
    return typeof hostIp === 'string' && hostIp.trim() !== '' && hostIp.trim() !== '0.0.0.0';
  });
}
