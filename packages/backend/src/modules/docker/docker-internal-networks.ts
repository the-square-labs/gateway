export function isGatewayManagedDockerNetwork(name: string) {
  return name.startsWith('gateway-db-');
}
