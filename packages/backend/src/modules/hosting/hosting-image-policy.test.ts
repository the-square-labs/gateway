import { describe, expect, it } from 'vitest';
import { applyHostingImagePolicy, hostingImageRoles } from './hosting-image-policy.js';
import { HOSTING_CLOUD_IMAGES } from './hosting-images.js';
import type { HostingCatalogOption } from './hosting-provider.types.js';

const image: HostingCatalogOption = {
  id: 'image',
  name: 'Ubuntu',
  architecture: 'x64',
  operatingSystem: { distribution: 'ubuntu', version: '24.04' },
};
describe('shared hosting OS admission policy', () => {
  it.each([
    'digitalocean',
    'hostkey',
    'hetzner',
    'proxmox',
  ] as const)('applies the same exact version/architecture matrix to %s', (provider) => {
    for (const candidate of HOSTING_CLOUD_IMAGES) expect(hostingImageRoles(candidate, provider)).toContain('docker');
    for (const candidate of [
      { ...image, operatingSystem: undefined, supportedRoles: ['docker'] as const },
      { ...image, operatingSystem: { distribution: 'ubuntu', version: '28.04' } },
      { ...image, operatingSystem: { distribution: 'fedora', version: '42' } },
      { ...image, operatingSystem: { distribution: 'debian', version: '10' } },
      { ...image, architecture: 'arm64' },
      { ...image, architecture: undefined },
      { ...image, operatingSystem: { distribution: 'unknown' } },
    ])
      expect(hostingImageRoles(candidate as HostingCatalogOption, provider)).toEqual([]);
  });
  it.each([
    ['ubuntu', '22.04'],
    ['ubuntu', '24.04'],
    ['ubuntu', '26.04'],
    ['debian', '11'],
    ['debian', '12'],
    ['debian', '13'],
    ['fedora', '43'],
    ['fedora', '44'],
  ] as const)('admits installer-compatible %s %s independently of downloadable Proxmox builds', (distribution, version) => {
    const candidate = { ...image, operatingSystem: { distribution, version } };
    for (const provider of ['digitalocean', 'hostkey', 'hetzner'] as const)
      expect(hostingImageRoles(candidate, provider)).toEqual([
        'nginx',
        'docker',
        'builder',
        'databases',
        'monitoring',
        'relay',
      ]);
    expect(
      HOSTING_CLOUD_IMAGES.map((build) => `${build.operatingSystem.distribution}-${build.operatingSystem.version}`)
    ).toEqual(['ubuntu-24.04', 'debian-13', 'ubuntu-22.04', 'debian-12', 'fedora-44']);
  });
  it('does not turn a role restriction into universal compatibility', () => {
    expect(hostingImageRoles({ ...image, supportedRoles: ['monitoring'] }, 'digitalocean')).toEqual(['monitoring']);
    expect(hostingImageRoles({ ...image, supportedRoles: [] }, 'proxmox')).toEqual([]);
  });
  it('exposes Relay on compatible images for every provider with installer-owned prerequisites', () => {
    for (const provider of ['digitalocean', 'hostkey', 'hetzner', 'proxmox'] as const)
      expect(hostingImageRoles(image, provider)).toContain('relay');
  });
  it('removes unsupported images without changing VM identity, inventory, sizes or locations', () => {
    const catalog = {
      locations: [{ id: 'eu', name: 'EU' }],
      sizes: [{ id: 'small', name: 'Small' }],
      images: [image, { id: 'unknown', name: 'Ubuntu AI/ML' }],
    };
    const filtered = applyHostingImagePolicy(catalog, 'digitalocean');
    expect(filtered.sizes).toBe(catalog.sizes);
    expect(filtered.locations).toBe(catalog.locations);
    expect(filtered.images.map((item) => item.id)).toEqual(['image']);
    expect(catalog.images).toHaveLength(2);
  });
});
