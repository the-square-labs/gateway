export function isGatewayManagedDockerNetwork(name: string) {
  return name.startsWith("gateway-db-");
}

export function filterUserDockerNetworks<T extends { name?: string; Name?: string }>(
  networks: T[]
) {
  return networks.filter(
    (network) => !isGatewayManagedDockerNetwork(String(network.name ?? network.Name ?? ""))
  );
}
