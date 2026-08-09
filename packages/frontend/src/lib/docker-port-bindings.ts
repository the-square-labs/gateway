import type { Node, NodeDetail } from "@/types";

export interface DockerPortBindAddressOption {
  value: string;
  label: string;
}

export const DEFAULT_DOCKER_PORT_BIND_ADDRESS_OPTIONS: DockerPortBindAddressOption[] = [
  { value: "0.0.0.0", label: "All interfaces (0.0.0.0)" },
];

export function hasDockerPortBindIpV1Capability(
  node: Node | NodeDetail | null | undefined
): boolean {
  const capabilities = (node?.capabilities ?? {}) as Record<string, unknown>;
  return (
    capabilities.dockerPortBindIpV1 === true ||
    capabilities.docker_port_bind_ip_v1 === true ||
    (Array.isArray(capabilities.capabilities) &&
      capabilities.capabilities.includes("docker_port_bind_ip_v1"))
  );
}

export function deriveDockerPortBindAddressOptions(
  node: Node | NodeDetail | null | undefined
): DockerPortBindAddressOption[] {
  if (!hasDockerPortBindIpV1Capability(node)) return DEFAULT_DOCKER_PORT_BIND_ADDRESS_OPTIONS;

  const health =
    (node as NodeDetail | undefined)?.liveHealthReport ?? node?.lastHealthReport ?? null;
  const options: DockerPortBindAddressOption[] = [
    ...DEFAULT_DOCKER_PORT_BIND_ADDRESS_OPTIONS,
    { value: "127.0.0.1", label: "Loopback (127.0.0.1)" },
  ];
  const seen = new Set(options.map((option) => option.value));
  for (const networkInterface of health?.networkInterfaces ?? []) {
    for (const address of networkInterface.ipAddresses ?? []) {
      if (!address || seen.has(address)) continue;
      seen.add(address);
      options.push({ value: address, label: `${networkInterface.name} (${address})` });
    }
  }
  return options;
}
