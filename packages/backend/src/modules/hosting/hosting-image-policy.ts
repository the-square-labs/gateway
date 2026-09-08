import type { HostingCatalog, HostingCatalogOption, HostingProvider, HostingRole } from './hosting-provider.types.js';

/** Installer/package compatibility, deliberately independent of Proxmox's pinned image catalog.
 * Reviewed 2026-09-05 against the existing installers and Docker/Nginx package support matrices.
 * https://docs.docker.com/engine/install/{ubuntu,debian,fedora}/
 * https://nginx.org/en/linux_packages.html
 * This is admission policy, not a claim of completed image/role E2E testing.
 */
export const HOSTING_INSTALLER_OS_VERSIONS: Record<'ubuntu' | 'debian' | 'fedora', readonly string[]> = {
  ubuntu: ['22.04', '24.04', '26.04'],
  debian: ['11', '12', '13'],
  fedora: ['43', '44'],
};
const baseRoles: HostingRole[] = ['nginx', 'docker', 'builder', 'databases', 'monitoring', 'relay'];

export function hostingImageRoles(image: HostingCatalogOption, _provider: HostingProvider): HostingRole[] {
  const os = image.operatingSystem;
  if (!os || image.architecture !== 'x64' || !HOSTING_INSTALLER_OS_VERSIONS[os.distribution]?.includes(os.version))
    return [];
  // Each released installer prepares its own prerequisites, including Relay.
  return baseRoles.filter((role) => image.supportedRoles === undefined || image.supportedRoles.includes(role));
}

export function applyHostingImagePolicy(catalog: HostingCatalog, provider: HostingProvider): HostingCatalog {
  return {
    ...catalog,
    images: catalog.images.flatMap((image) => {
      const supportedRoles = hostingImageRoles(image, provider);
      return supportedRoles.length ? [{ ...image, supportedRoles }] : [];
    }),
  };
}

/** Only exact plain OS names qualify; application suffixes and unknown architecture fail closed. */
export function hostingOsIdentity(distribution: string, version: string): HostingCatalogOption['operatingSystem'] {
  const family = distribution.toLowerCase();
  if (family !== 'ubuntu' && family !== 'debian' && family !== 'fedora') return undefined;
  return { distribution: family, version };
}
