export function isInternalAvailabilityImage(reference: string): boolean {
  return /^(?:[^/]+\/)?gateway\/availability\//i.test(reference);
}

export function isUserDockerRegistry(registry: { id: string; source?: string }): boolean {
  return registry.source !== "system" && registry.id !== "gateway-internal-registry";
}
