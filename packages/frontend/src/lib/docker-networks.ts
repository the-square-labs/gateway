/** A storage link network (`gateway-storage-<16 hex>`) or a managed storage cluster network. */
const GATEWAY_STORAGE_NETWORK =
  /^gateway-storage-(?:[0-9a-f]{16}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

/** Mirrors the backend: Secure Links, managed database and managed storage networks. */
export function isGatewayManagedDockerNetwork(name: string) {
  return (
    name === "gateway-secure-links" ||
    name.startsWith("gateway-db-") ||
    GATEWAY_STORAGE_NETWORK.test(name)
  );
}

export function filterUserDockerNetworks<T extends { name?: string; Name?: string }>(
  networks: T[]
) {
  return networks.filter(
    (network) => !isGatewayManagedDockerNetwork(String(network.name ?? network.Name ?? ""))
  );
}
