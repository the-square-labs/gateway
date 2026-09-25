/**
 * The network a storage link's connector shares with its one workload on a
 * Docker node (`gateway-storage-<16 hex>`, see managed-storage-bindings), or a
 * managed storage cluster network (`gateway-storage-<cluster uuid>`). Mirrors
 * the daemon's storageBindingNetworkNamePattern.
 */
const GATEWAY_STORAGE_NETWORK =
  /^gateway-storage-(?:[0-9a-f]{16}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

/**
 * Networks Gateway owns on a Docker node. Users can neither list, connect,
 * disconnect nor remove them, and a user container cannot be created on one:
 * the Secure Links management network, managed database link networks
 * (`gateway-db-*`) and managed storage networks. The link services attach
 * their workloads through the daemon directly.
 */
export function isGatewayManagedDockerNetwork(name: string) {
  return name === 'gateway-secure-links' || name.startsWith('gateway-db-') || GATEWAY_STORAGE_NETWORK.test(name);
}

/** Names users may not give a network they create: every Gateway-managed name, now or later. */
export function isReservedGatewayNetworkName(name: string) {
  return name === 'gateway-secure-links' || name.startsWith('gateway-db-') || name.startsWith('gateway-storage-');
}
