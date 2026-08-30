export function isGatewayManagedDockerNetwork(name: string) {
  return name === 'gateway-secure-links' || name.startsWith('gateway-db-');
}
