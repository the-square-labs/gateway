export function validateEnrollmentDaemonProfile(nodeType: string, daemonType: string): string | null {
  if (['builder', 'storage', 'databases'].includes(nodeType) && daemonType !== 'docker') {
    return nodeType === 'builder'
      ? 'Builder node enrollment requires docker-daemon identity'
      : 'Storage node enrollment requires docker-daemon identity';
  }
  return null;
}

export function validateRegisteredDaemonProfile(
  nodeType: string,
  daemonType: string,
  capabilities: readonly string[] | null | undefined
): string | null {
  if (nodeType === 'storage' || nodeType === 'databases') {
    const advertised = new Set(capabilities ?? []);
    if (daemonType !== 'docker' || !advertised.has('managed_databases_v1'))
      return 'Storage node requires the restricted stateful docker-daemon profile';
    if (nodeType === 'storage' && !advertised.has('managed_storage_v1'))
      return 'Storage node requires managed storage capabilities; update the daemon';
    if (advertised.has('docker_deployments_v1') || advertised.has('docker_builder_profile_v1'))
      return 'Storage node advertised a conflicting Docker daemon profile';
    return null;
  }
  if (nodeType !== 'builder') return null;
  const advertised = new Set(capabilities ?? []);
  if (daemonType !== 'docker' || !advertised.has('docker_builder_profile_v1')) {
    return 'Builder node requires the docker-daemon builder profile';
  }
  if (advertised.has('docker_deployments_v1') || advertised.has('managed_databases_v1')) {
    return 'Builder node advertised a conflicting Docker daemon profile';
  }
  return null;
}
