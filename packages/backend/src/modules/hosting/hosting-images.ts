import { AppError } from '@/middleware/error-handler.js';
import type { HostingRole } from './hosting-provider.types.js';

export interface HostingCloudImage {
  id: string;
  name: string;
  url: string;
  checksum: string;
  checksumAlgorithm: 'sha256' | 'sha512';
  architecture: 'x64';
  operatingSystem: { distribution: 'ubuntu' | 'debian' | 'fedora'; version: string };
  diskGb: number;
  supportedRoles: HostingRole[];
}
const roles: HostingRole[] = ['nginx', 'docker', 'builder', 'databases', 'monitoring', 'relay'];
/** Reviewed immutable upstream builds, not mutable latest URLs or user-supplied downloads.
 * Alpine is deliberately not advertised until its image/role smoke tests pass; Arch is out of scope.
 */
export const HOSTING_CLOUD_IMAGES: readonly HostingCloudImage[] = [
  {
    id: 'ubuntu-24.04-20260826-amd64',
    name: 'Ubuntu 24.04 LTS',
    operatingSystem: { distribution: 'ubuntu', version: '24.04' },
    url: 'https://cloud-images.ubuntu.com/noble/20260826/noble-server-cloudimg-amd64.img',
    checksum: 'd0fe84bb5f80853425fa6be28e2c106f30104c3cfe8611933f2e65c9b63f0e30',
    checksumAlgorithm: 'sha256',
    architecture: 'x64',
    diskGb: 4,
    supportedRoles: roles,
  },
  {
    id: 'debian-13-20260831-2587-amd64',
    name: 'Debian 13',
    operatingSystem: { distribution: 'debian', version: '13' },
    url: 'https://cloud.debian.org/images/cloud/trixie/20260831-2587/debian-13-generic-amd64-20260831-2587.qcow2',
    checksum:
      '5a069019420fb9441ad4f8004c661fadb747edd5662ca54a17c8f923dee7d717e21dbdaa4ba72d6fce7f920e0217f0a9af382298a7d46ed4bc9dc33ac19181b6',
    checksumAlgorithm: 'sha512',
    architecture: 'x64',
    diskGb: 4,
    supportedRoles: roles,
  },
  {
    id: 'fedora-44-1.7-x86_64',
    name: 'Fedora Cloud 44',
    operatingSystem: { distribution: 'fedora', version: '44' },
    url: 'https://dl.fedoraproject.org/pub/fedora/linux/releases/44/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-44-1.7.x86_64.qcow2',
    checksum: '28680fe5b371a5a82ebf43a31926e086a168e59949d03969c5093e7071f90b7f',
    checksumAlgorithm: 'sha256',
    architecture: 'x64',
    diskGb: 5,
    supportedRoles: roles,
  },
];

export function hostingCloudImage(id: string, role?: HostingRole): HostingCloudImage {
  const image = HOSTING_CLOUD_IMAGES.find((candidate) => candidate.id === id);
  if (!image || (role && !image.supportedRoles.includes(role)))
    throw new AppError(400, 'HOSTING_IMAGE_UNSUPPORTED', 'Choose a supported operating system for this node role');
  return image;
}

export function hostingImageFilename(image: HostingCloudImage) {
  return `gateway-${image.id}-${image.checksum.slice(0, 16)}.qcow2`;
}
