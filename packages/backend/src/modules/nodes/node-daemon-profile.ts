export function validateEnrollmentDaemonProfile(nodeType: string, daemonType: string): string | null {
  if (nodeType === 'builder' && daemonType !== 'docker') {
    return 'Builder node enrollment requires docker-daemon identity';
  }
  return null;
}

export function validateRegisteredDaemonProfile(
  nodeType: string,
  daemonType: string,
  capabilities: readonly string[] | null | undefined
): string | null {
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
