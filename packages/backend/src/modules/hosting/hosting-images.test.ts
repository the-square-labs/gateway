import { describe, expect, it } from 'vitest';
import { HOSTING_CLOUD_IMAGES, hostingCloudImage, hostingImageFilename } from './hosting-images.js';
import type { HostingCreateRequest } from './hosting-provider.types.js';
import { proxmoxSeedFiles } from './proxmox-seed.js';

describe('canonical cloud images and NoCloud media', () => {
  it('pins official immutable builds with strong checksums and excludes unverified distributions', () => {
    expect(HOSTING_CLOUD_IMAGES).toHaveLength(5);
    expect(HOSTING_CLOUD_IMAGES.map((image) => image.name)).toEqual(
      expect.arrayContaining(['Ubuntu 22.04 LTS', 'Debian 12'])
    );
    for (const image of HOSTING_CLOUD_IMAGES) {
      const url = new URL(image.url);
      expect(url.protocol).toBe('https:');
      expect(['cloud-images.ubuntu.com', 'cloud.debian.org', 'dl.fedoraproject.org']).toContain(url.hostname);
      expect(url.pathname).not.toMatch(/latest|current|daily/);
      expect(image.checksum).toMatch(image.checksumAlgorithm === 'sha256' ? /^[a-f0-9]{64}$/ : /^[a-f0-9]{128}$/);
      expect(hostingImageFilename(image)).toMatch(/^gateway-[a-z0-9._-]+\.qcow2$/);
      expect(image.supportedRoles).not.toHaveLength(0);
    }
    for (const id of ['arch', 'alpine', 'https://evil.test/image.qcow2', '9000'])
      expect(() => hostingCloudImage(id)).toThrow();
  });
  const input: HostingCreateRequest = {
    name: 'node-1',
    marker: 'gw-11111111-1111-4111-8111-111111111111',
    location: 'pve',
    size: 'custom',
    image: HOSTING_CLOUD_IMAGES[0]!.id,
    userData: '#!/bin/bash\necho secret-enrollment',
    ipConfig: 'ip=10.0.0.10/24,gw=10.0.0.1',
    proxmox: {
      nodes: ['pve'],
      storage: 'zfs',
      bridge: 'vmbr0',
      network: 'static',
      dnsServers: ['10.0.0.1'],
      mtu: 1500,
    },
  };
  it('contains per-operation identity, static network and bootstraps QGA before the daemon', () => {
    const files = proxmoxSeedFiles(input, 'AA:BB:CC:DD:EE:FF');
    expect(JSON.parse(files['meta-data'])['instance-id']).toBe(input.marker);
    const net = JSON.parse(files['network-config']).ethernets.gateway0;
    expect(net).toMatchObject({
      match: { macaddress: 'aa:bb:cc:dd:ee:ff' },
      dhcp4: false,
      addresses: ['10.0.0.10/24'],
      routes: [{ to: '0.0.0.0/0', via: '10.0.0.1' }],
      nameservers: { addresses: ['10.0.0.1'] },
    });
    const cloud = JSON.parse(files['user-data'].replace('#cloud-config\n', ''));
    expect(cloud.packages).toContain('qemu-guest-agent');
    expect(cloud.packages).toContain('bash');
    expect(cloud.ssh_pwauth).toBe(false);
    expect(cloud.write_files[0]).toMatchObject({ permissions: '0700', content: input.userData });
    expect(cloud.runcmd[1]).toEqual([
      'bash',
      '-c',
      'trap "rm -f /var/lib/gateway-hosting-bootstrap.sh" EXIT; bash /var/lib/gateway-hosting-bootstrap.sh',
    ]);
    expect(files['user-data']).not.toContain('cloud-init status --wait');
  });
  it('emits DHCP without static routes and refuses unowned seed identities', () => {
    const files = proxmoxSeedFiles({ ...input, ipConfig: 'ip=dhcp' }, 'AA:BB:CC:DD:EE:FF');
    expect(JSON.parse(files['network-config']).ethernets.gateway0).toMatchObject({ dhcp4: true });
    expect(files['network-config']).not.toContain('routes');
    expect(() => proxmoxSeedFiles({ ...input, marker: '../../etc' }, 'AA:BB:CC:DD:EE:FF')).toThrow();
    expect(() => proxmoxSeedFiles(input, 'invalid')).toThrow();
  });
});
