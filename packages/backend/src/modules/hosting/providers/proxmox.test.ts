import { webcrypto, X509Certificate } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { describe, expect, it, vi } from 'vitest';
import { HostingSettingsSchema } from '../hosting.schemas.js';
import { type HostingHttp, HostingProviderError } from '../hosting-http.js';
import { HOSTING_CLOUD_IMAGES, hostingImageFilename } from '../hosting-images.js';
import {
  type HostingConnection,
  type HostingCreateRequest,
  type HostingResourceSnapshot,
  hostingCapabilities,
} from '../hosting-provider.types.js';
import { ProxmoxHostingAdapter } from './proxmox.js';

vi.mock('../proxmox-seed.js', () => ({
  assertProxmoxSeedRuntime: vi.fn(async () => {}),
  buildProxmoxSeed: vi.fn(async () => Buffer.from('seed iso')),
}));

async function certificateEvidence(subject = 'CN=Gateway Test CA') {
  const now = Date.now();
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const caKeys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: subject,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 86_400_000),
    keys: caKeys,
    signingAlgorithm: algorithm,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  const leafKeys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: '02',
    subject: 'CN=pve.test',
    issuer: root.subject,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 86_400_000),
    publicKey: leafKeys.publicKey,
    signingKey: caKeys.privateKey,
    signingAlgorithm: algorithm,
    extensions: [new x509.BasicConstraintsExtension(false, undefined, true)],
  });
  const rootPem = root.toString('pem');
  return [
    { filename: 'pve-root-ca.pem', fingerprint: new X509Certificate(rootPem).fingerprint256, pem: rootPem },
    { filename: 'pve-ssl.pem', pem: leaf.toString('pem') },
  ];
}

const connection: HostingConnection = {
  provider: 'proxmox',
  baseUrl: 'https://pve.test:8006',
  token: 'do-not-log',
  settings: HostingSettingsSchema.parse({
    tokenId: 'gateway@pve!hosting',
    proxmoxHost: 'pve',
    proxmox: {
      nodes: ['pve'],
      templateId: 9000,
      templateNode: 'pve',
      storage: 'local-lvm',
      bridge: 'vmbr0',
      pool: 'gateway',
      cleanTemplate: true,
      vmidRange: '250-260',
    },
  }),
};
const input: HostingCreateRequest = {
  name: 'docker-1',
  size: 'custom',
  image: '9000',
  location: 'pve',
  marker: 'gw-operation-1',
  userData: '#!/bin/bash\ntrue',
  cpu: 2,
  memoryMb: 2048,
  diskGb: 32,
  vmid: 251,
  proxmox: connection.settings.proxmox,
};
const resource: HostingResourceSnapshot = {
  remoteId: '250',
  kind: 'vm',
  name: 'docker-1',
  location: 'pve',
  powerState: 'stopped',
  cpu: 2,
  memoryMb: 2048,
  diskGb: 16,
  addresses: [],
  incarnation: 'smbios:uuid',
  capabilities: hostingCapabilities({ bootstrap: true, guestIdentity: true }),
  observedAt: '2026-09-05T00:00:00Z',
};
function fakeFor(testConnection: HostingConnection, ...data: unknown[]) {
  const request = vi.fn();
  for (const value of data) {
    if (value instanceof Error) request.mockRejectedValueOnce(value);
    else request.mockResolvedValueOnce({ data: value });
  }
  const http: HostingHttp = { request };
  return { adapter: new ProxmoxHostingAdapter(testConnection, http), request };
}
function fake(...data: unknown[]) {
  return fakeFor(connection, ...data);
}

describe('Proxmox hosting adapter', () => {
  const cloudProfile = { ...connection.settings.proxmox!, imageStorage: 'local', seedStorage: 'local' };
  const cloudInput: HostingCreateRequest = {
    ...input,
    image: HOSTING_CLOUD_IMAGES[0]!.id,
    role: 'docker',
    marker: 'gw-11111111-1111-4111-8111-111111111111',
    proxmox: cloudProfile,
  };
  const cloudResource = { ...resource, remoteId: String(cloudInput.vmid), marker: cloudInput.marker };
  const cloudConnection = { ...connection, settings: { ...connection.settings, proxmox: cloudProfile } };
  const imageVolume = `local:import/${hostingImageFilename(HOSTING_CLOUD_IMAGES[0]!).replace('.qcow2', `-${cloudInput.marker}.qcow2`)}`;
  const seedVolume = `local:iso/gateway-seed-${cloudInput.marker}.iso`;
  const config = { net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0' };
  it('lists canonical images without reading a template', async () => {
    const { adapter, request } = fakeFor(cloudConnection, [{ type: 'node', node: 'pve', status: 'online' }], {
      active: 1,
    });
    const catalog = await adapter.catalog();
    expect(catalog.images.map((image) => image.id)).toEqual(HOSTING_CLOUD_IMAGES.map((image) => image.id));
    expect(request.mock.calls.some(([path]) => String(path).includes('/qemu/'))).toBe(false);
  });
  it.each([false, true])('creates with VM or durable resource-pool permissions (pool=%s)', async (usePool) => {
    const permissions = Object.fromEntries([
      ['/storage/local', { 'Datastore.AllocateTemplate': 1, 'Datastore.Allocate': 1 }],
      ['/storage/local-lvm', { 'Datastore.AllocateSpace': 1 }],
      ['/nodes/pve', { 'Sys.AccessNetwork': 1 }],
      [
        usePool ? '/pool/hosting-test' : '/vms/251',
        Object.fromEntries(
          [
            'VM.Allocate',
            'VM.Config.CPU',
            'VM.Config.Memory',
            'VM.Config.Disk',
            'VM.Config.Network',
            'VM.Config.Options',
            'VM.Config.CDROM',
            'VM.PowerMgmt',
          ].map((key) => [key, 1])
        ),
      ],
    ]);
    const storage = [
      { storage: 'local', content: 'iso,import', active: 1 },
      { storage: 'local-lvm', content: 'images', active: 1 },
    ];
    const requestInput = { ...cloudInput, proxmox: { ...cloudProfile, ...(usePool ? { pool: 'hosting-test' } : {}) } };
    const { adapter, request } = fakeFor(cloudConnection, storage, permissions, '251', 'UPID:pve:create');
    expect(await adapter.create(requestInput)).toMatchObject({ resourceId: '251', status: 'running' });
    expect(request).toHaveBeenLastCalledWith(
      '/api2/json/nodes/pve/qemu',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          vmid: 251,
          smbios1: 'uuid=11111111-1111-4111-8111-111111111111',
          description: `Gateway hosting ${cloudInput.marker}`,
          net0: 'virtio,bridge=vmbr0,firewall=1',
          ...(usePool ? { pool: 'hosting-test' } : {}),
        }),
      })
    );
    expect(request.mock.calls.some(([path]) => String(path).includes('/clone'))).toBe(false);
    if (usePool) {
      const wrongPool = fakeFor(cloudConnection, storage, permissions);
      await expect(
        wrongPool.adapter.validateCreate({ ...requestInput, proxmox: { ...requestInput.proxmox, pool: 'other' } })
      ).rejects.toMatchObject({ code: 'HOSTING_PROVIDER_PERMISSION_REQUIRED' });
    }
    const denied = fakeFor(cloudConnection, storage, {});
    await expect(denied.adapter.create(cloudInput)).rejects.toMatchObject({
      code: 'HOSTING_PROVIDER_PERMISSION_REQUIRED',
    });
    expect(denied.request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it('downloads only a pinned official image with checksum verification', async () => {
    const { adapter, request } = fakeFor(cloudConnection, config, [], 'UPID:pve:download');
    expect(await adapter.prepare(cloudResource, cloudInput)).toMatchObject({ preparationStage: 'image' });
    expect(request).toHaveBeenLastCalledWith('/api2/json/nodes/pve/storage/local/download-url', {
      method: 'POST',
      body: expect.objectContaining({
        content: 'import',
        url: HOSTING_CLOUD_IMAGES[0]!.url,
        checksum: HOSTING_CLOUD_IMAGES[0]!.checksum,
        'verify-certificates': 1,
      }),
    });
  });
  it('persists the selected write stage before dispatching and recovers its lost response read-only', async () => {
    const beforePreparation = vi.fn(async () => {});
    const { adapter, request } = fakeFor(cloudConnection, config, [], 'UPID:pve:download');
    await adapter.prepare(cloudResource, { ...cloudInput, beforePreparation });
    expect(beforePreparation).toHaveBeenCalledWith('image');
    expect(beforePreparation.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[2]!);
    const filename = imageVolume.split('/').at(-1)!;
    const upid = 'UPID:pve:1:2:3:download:file:gateway@pve!hosting:';
    const recovery = fakeFor(cloudConnection, [{ upid, id: filename, starttime: 100 }]);
    expect(await recovery.adapter.reconcilePreparation(cloudResource, cloudInput, 'image', 100)).toMatchObject({
      id: upid,
      preparationStage: 'image',
    });
    expect(recovery.request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it('recovers upload only from a matching task log and never guesses between ambiguous tasks', async () => {
    const upid = 'UPID:pve:1:2:3:imgcopy::gateway@pve!hosting:';
    const recovery = fakeFor(
      cloudConnection,
      [{ upid, starttime: 100 }],
      [{ t: `target file: /var/lib/vz/template/iso/gateway-seed-${cloudInput.marker}.iso` }]
    );
    expect(await recovery.adapter.reconcilePreparation(cloudResource, cloudInput, 'seed', 100)).toMatchObject({
      id: upid,
      preparationStage: 'seed',
    });
    const ambiguous = fakeFor(cloudConnection, [
      { upid: upid.replace('imgcopy', 'qmconfig'), id: '251', starttime: 100 },
      { upid: upid.replace('imgcopy', 'qmconfig').replace(':1:', ':4:'), id: '251', starttime: 101 },
    ]);
    expect(await ambiguous.adapter.reconcilePreparation(cloudResource, cloudInput, 'disk', 100)).toBeNull();
  });
  it('uploads operation-specific NoCloud media before importing the boot disk', async () => {
    const seed = fakeFor(cloudConnection, config, [{ volid: imageVolume }], [], 'UPID:pve:upload');
    expect(await seed.adapter.prepare(cloudResource, { ...cloudInput, preparationStage: 'image' })).toMatchObject({
      preparationStage: 'seed',
    });
    expect(seed.request).toHaveBeenLastCalledWith(
      '/api2/json/nodes/pve/storage/local/upload',
      expect.objectContaining({
        seedIso: { filename: `gateway-seed-${cloudInput.marker}.iso`, data: Buffer.from('seed iso') },
      })
    );
    const disk = fakeFor(cloudConnection, config, [{ volid: imageVolume }], [{ volid: seedVolume }], 'UPID:pve:config');
    expect(await disk.adapter.prepare(cloudResource, { ...cloudInput, preparationStage: 'seed' })).toMatchObject({
      preparationStage: 'disk',
    });
    expect(disk.request).toHaveBeenLastCalledWith('/api2/json/nodes/pve/qemu/251/config', {
      method: 'POST',
      body: { scsi0: `local-lvm:0,import-from=${imageVolume}`, ide2: `${seedVolume},media=cdrom` },
    });
  });
  const bootConfig = {
    ...config,
    scsi0: 'local-lvm:vm-251-disk-0,size=32G',
    ide2: `${seedVolume},media=cdrom`,
    boot: 'order=scsi0',
  };
  it('sets boot order in a separate durable step after the disk import, without starting the VM', async () => {
    const beforePreparation = vi.fn(async () => {});
    const { adapter, request } = fakeFor(
      cloudConnection,
      { ...bootConfig, boot: 'order=net0;ide2' },
      [{ volid: imageVolume }],
      [{ volid: seedVolume }],
      'UPID:pve:boot'
    );
    expect(
      await adapter.prepare(cloudResource, { ...cloudInput, preparationStage: 'disk', beforePreparation })
    ).toMatchObject({ id: 'UPID:pve:boot', preparationStage: 'boot' });
    expect(beforePreparation).toHaveBeenCalledWith('boot');
    expect(beforePreparation.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[3]!);
    expect(request).toHaveBeenLastCalledWith('/api2/json/nodes/pve/qemu/251/config', {
      method: 'POST',
      body: { boot: 'order=scsi0' },
    });
    expect(request.mock.calls.some(([path]) => String(path).endsWith('/status/start'))).toBe(false);
  });
  it.each([
    'order=net0;ide2',
    'order=net0;scsi0',
    undefined,
  ])('does not resize or start when the confirmed boot task left incorrect configuration (%s)', async (boot) => {
    const { adapter, request } = fakeFor(
      cloudConnection,
      { ...bootConfig, boot },
      [{ volid: imageVolume }],
      [{ volid: seedVolume }]
    );
    await expect(adapter.prepare(cloudResource, { ...cloudInput, preparationStage: 'boot' })).rejects.toMatchObject({
      code: 'HOSTING_BOOT_ORDER_UNVERIFIED',
    });
    expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it('recovers a lost boot response from matching config without importing or starting again', async () => {
    const { adapter, request } = fakeFor(cloudConnection, bootConfig);
    expect(await adapter.reconcilePreparation(cloudResource, cloudInput, 'boot', 100)).toMatchObject({
      status: 'succeeded',
      preparationStage: 'boot',
    });
    expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it.each([
    { boot: 'order=net0;ide2' },
    { lock: 'create' },
    { ide2: 'local:iso/unrelated.iso,media=cdrom' },
    { scsi0: 'other:vm-251-disk-0' },
    { scsi0: 'local-lvm:vm-999-disk-0,size=32G' },
    { scsi0: 'local-lvm:999/vm-251-disk-0.qcow2,size=32G' },
  ])('does not recover an unconfirmed or mismatched boot configuration (%j)', async (change) => {
    const { adapter, request } = fakeFor(cloudConnection, { ...bootConfig, ...change });
    expect(await adapter.reconcilePreparation(cloudResource, cloudInput, 'boot', 100)).toBeNull();
    expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it.each([
    'local-lvm:vm-999-disk-0,size=32G',
    'local-lvm:999/vm-999-disk-0.qcow2,size=32G',
  ])('refuses a foreign imported disk on the same storage before configuring or starting (%s)', async (scsi0) => {
    for (const preparationStage of ['disk', 'boot'] as const) {
      const { adapter, request } = fakeFor(
        cloudConnection,
        { ...bootConfig, scsi0 },
        [{ volid: imageVolume }],
        [{ volid: seedVolume }]
      );
      await expect(adapter.prepare(cloudResource, { ...cloudInput, preparationStage })).rejects.toMatchObject({
        code: 'HOSTING_RESOURCE_IDENTITY_CONFLICT',
      });
      expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    }
  });
  it('accepts the imported disk owned by this VM on directory storage', async () => {
    const { adapter } = fakeFor(cloudConnection, {
      ...bootConfig,
      scsi0: 'local-lvm:251/vm-251-disk-0.qcow2,size=32G',
    });
    expect(await adapter.reconcilePreparation(cloudResource, cloudInput, 'boot', 100)).toMatchObject({
      status: 'succeeded',
    });
  });
  it('starts only after boot order and disks match and refuses an unrelated VM', async () => {
    const { adapter, request } = fakeFor(
      cloudConnection,
      { ...bootConfig, net0: `${config.net0},firewall=1` },
      [{ volid: imageVolume }],
      [{ volid: seedVolume }],
      { enable: 0 },
      'UPID:pve:start'
    );
    expect(
      await adapter.prepare({ ...cloudResource, diskGb: 32 }, { ...cloudInput, preparationStage: 'network' })
    ).toMatchObject({
      preparationStage: 'start',
    });
    expect(request).toHaveBeenLastCalledWith('/api2/json/nodes/pve/qemu/251/status/start', {
      method: 'POST',
      body: {},
    });
    await expect(adapter.prepare({ ...cloudResource, marker: 'someone-else' }, cloudInput)).rejects.toMatchObject({
      code: 'HOSTING_RESOURCE_IDENTITY_CONFLICT',
    });
  });
  it('detaches and removes only its exact operation ISO and scratch image, never the VM', async () => {
    const { adapter, request } = fakeFor(
      cloudConnection,
      { ide2: `${seedVolume},media=cdrom` },
      null,
      [{ volid: seedVolume }],
      null,
      [{ volid: imageVolume }],
      null
    );
    await adapter.cleanupBootstrap(cloudResource, cloudInput);
    expect(request).toHaveBeenCalledWith('/api2/json/nodes/pve/qemu/251/config', {
      method: 'PUT',
      body: { ide2: 'none,media=cdrom' },
    });
    expect(request).toHaveBeenLastCalledWith(
      `/api2/json/nodes/pve/storage/local/content/${encodeURIComponent(imageVolume)}`,
      { method: 'DELETE' }
    );
  });
  it('prepares older stopped image NICs only after disabling the VM firewall and preserves their network settings', async () => {
    const net0 = `${config.net0},tag=2020,mtu=1400,firewall=0`;
    const { adapter, request } = fakeFor(
      cloudConnection,
      { ...bootConfig, net0, digest: 'network-config' },
      [{ volid: imageVolume }],
      [{ volid: seedVolume }],
      { enable: 0 },
      null,
      { ...bootConfig, net0: `${config.net0},tag=2020,mtu=1400,firewall=1` }
    );
    expect(
      await adapter.prepare({ ...cloudResource, diskGb: 32 }, { ...cloudInput, preparationStage: 'firewall' })
    ).toMatchObject({ preparationStage: 'network' });
    expect(request.mock.calls[4]).toEqual([
      '/api2/json/nodes/pve/qemu/251/config',
      { method: 'PUT', body: { net0: `${config.net0},tag=2020,mtu=1400,firewall=1`, digest: 'network-config' } },
    ]);
    expect(request.mock.calls.some(([path]) => String(path).endsWith('/status/start'))).toBe(false);
    expect(request.mock.calls.some(([path]) => String(path).includes('/cluster/firewall'))).toBe(false);
  });
  it.each([true, false])('refuses start if initial firewall safety checks fail (vmDisabled=%s)', async (vmDisabled) => {
    const { adapter, request } = fakeFor(
      cloudConnection,
      bootConfig,
      [{ volid: imageVolume }],
      [{ volid: seedVolume }],
      ...(vmDisabled ? [{ enable: 0 }, null, bootConfig] : [{ enable: 1 }, null, { enable: 1 }])
    );
    await expect(
      adapter.prepare(cloudResource, { ...cloudInput, preparationStage: vmDisabled ? 'firewall' : 'boot' })
    ).rejects.toMatchObject({
      code: 'HOSTING_INITIAL_FIREWALL_UNVERIFIED',
    });
    expect(request.mock.calls.some(([path]) => String(path).endsWith('/status/start'))).toBe(false);
    if (!vmDisabled) expect(request.mock.calls.some(([, options]) => options?.body?.net0)).toBe(false);
  });
  it('does not prepare initial firewall on a running image VM', async () => {
    const { adapter, request } = fakeFor(
      cloudConnection,
      bootConfig,
      [{ volid: imageVolume }],
      [{ volid: seedVolume }]
    );
    await expect(
      adapter.prepare({ ...cloudResource, powerState: 'running' }, { ...cloudInput, preparationStage: 'boot' })
    ).rejects.toMatchObject({ code: 'HOSTING_VM_MUST_STOP' });
    expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it.each([
    'firewall',
    'network',
  ] as const)('recovers an applied %s write with a lost response using read-only evidence', async (stage) => {
    const prepared = { ...bootConfig, net0: `${config.net0},firewall=1` };
    const beforePreparation = vi.fn(async () => {});
    const failed = fakeFor(
      cloudConnection,
      bootConfig,
      [{ volid: imageVolume }],
      [{ volid: seedVolume }],
      { enable: stage === 'firewall' ? 1 : 0 },
      new HostingProviderError(502, true, 'Response lost')
    );
    await expect(
      failed.adapter.prepare(cloudResource, {
        ...cloudInput,
        preparationStage: stage === 'firewall' ? 'boot' : 'firewall',
        beforePreparation,
      })
    ).rejects.toThrow('Response lost');
    expect(beforePreparation).toHaveBeenCalledWith(stage);
    expect(failed.request.mock.calls.some(([path]) => String(path).endsWith('/status/start'))).toBe(false);
    const recovery = fakeFor(cloudConnection, stage === 'network' ? prepared : bootConfig, { enable: 0 });
    expect(await recovery.adapter.reconcilePreparation(cloudResource, cloudInput, stage, 100)).toMatchObject({
      status: 'succeeded',
      preparationStage: stage,
    });
    expect(recovery.request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it.each(['firewall', 'network'] as const)('does not recover %s while VM filtering remains enabled', async (stage) => {
    const { adapter } = fakeFor(cloudConnection, bootConfig, { enable: 1 });
    expect(await adapter.reconcilePreparation(cloudResource, cloudInput, stage, 100)).toBeNull();
  });
  it('does not recover the NIC step from an incomplete network update', async () => {
    const { adapter } = fakeFor(cloudConnection, bootConfig, { enable: 0 });
    expect(await adapter.reconcilePreparation(cloudResource, cloudInput, 'network', 100)).toBeNull();
  });
  it('refuses existing images or seeds without persisted successful task evidence', async () => {
    const image = fakeFor(cloudConnection, config, [{ volid: imageVolume }]);
    await expect(image.adapter.prepare(cloudResource, cloudInput)).rejects.toMatchObject({
      code: 'HOSTING_IMAGE_UNVERIFIED',
    });
    expect(image.request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    const seed = fakeFor(cloudConnection, config, [{ volid: imageVolume }], [{ volid: seedVolume }]);
    await expect(
      seed.adapter.prepare(cloudResource, { ...cloudInput, preparationStage: 'image' })
    ).rejects.toMatchObject({ code: 'HOSTING_SEED_UNVERIFIED' });
  });
  it('quotes only the configured usable template and the selected storage capacity', async () => {
    const { adapter, request } = fake(
      [
        {
          type: 'node',
          node: 'pve',
          status: 'online',
          maxmem: 8 * 1024 ** 3,
          mem: 2 * 1024 ** 3,
          maxdisk: 1000 * 1024 ** 3,
        },
        { type: 'qemu', node: 'pve', vmid: 9000, template: 1, maxdisk: 40 * 1024 ** 3 },
        { type: 'qemu', node: 'pve', vmid: 9001, template: 1 },
      ],
      {
        template: 1,
        ostype: 'l26',
        agent: 'enabled=1',
        net0: 'virtio=AA:BB:CC:DD:EE:FF',
        scsi0: 'local:disk,size=40G',
        ide2: 'local:cloudinit',
      },
      { active: 1, total: 80 * 1024 ** 3, used: 30 * 1024 ** 3 }
    );
    const result = await adapter.catalog();
    expect(result.images).toEqual([{ id: '9000', name: '9000', locations: ['pve'], diskGb: 40 }]);
    expect(result.capacity?.[0]).toMatchObject({ diskTotalGb: 80, diskUsedGb: 30, online: true });
    expect(request).toHaveBeenLastCalledWith('/api2/json/nodes/pve/storage/local-lvm/status', undefined);
  });
  it('does not mutate any configuration when several disks have no identified boot device', async () => {
    const { adapter, request } = fake({ scsi1: 'local:data,size=16G', scsi0: 'local:root,size=16G' });
    await expect(adapter.action(resource, { action: 'resize', diskGb: 32 })).rejects.toMatchObject({
      code: 'HOSTING_DISK_UNKNOWN',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('resizes the boot disk instead of the first returned data disk', async () => {
    const { adapter, request } = fake(
      { scsi1: 'local:data,size=16G', scsi0: 'local:root,size=16G', boot: 'order=scsi0;net0' },
      null,
      null
    );
    await adapter.action(resource, { action: 'resize', diskGb: 32 });
    expect(request).toHaveBeenLastCalledWith('/api2/json/nodes/pve/qemu/250/resize', {
      method: 'PUT',
      body: { disk: 'scsi0', size: '32G' },
    });
  });
  it('checkpoints resize writes and never repeats an uncertain disk mutation', async () => {
    const checkpoint = vi.fn(async (_stage: string) => {});
    const { adapter, request } = fake({ scsi0: 'local:root,size=16G' }, null, null);
    await adapter.action(resource, { action: 'resize', cpu: 4, memoryMb: 4096, diskGb: 32 }, { checkpoint });
    expect(checkpoint.mock.calls.map(([stage]) => stage)).toEqual([
      'config_dispatching',
      'config_applied',
      'disk_dispatching',
    ]);
    const retry = fake({ scsi0: 'local:root,size=16G' });
    expect(
      await retry.adapter.action(resource, { action: 'resize', diskGb: 32 }, { stage: 'disk_dispatching', checkpoint })
    ).toMatchObject({ status: 'unknown' });
    expect(retry.request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(2);
  });
  it('reports a definite partial resize failure instead of waiting for a nonexistent task', async () => {
    const { adapter } = fake({ scsi0: 'local:root,size=16G' }, null, new HostingProviderError(403, false, 'denied'));
    await expect(adapter.action(resource, { action: 'resize', cpu: 4, diskGb: 32 })).rejects.toMatchObject({
      code: 'HOSTING_RESIZE_REJECTED',
    });
  });
  it('derives cluster authority from the PVE-managed certificate rather than a client cluster name', async () => {
    const evidence = await certificateEvidence();
    const fingerprint = evidence[0].fingerprint!.replaceAll(':', '').toLowerCase();
    const { adapter, request } = fake({ version: '9.0' }, [{ type: 'node', node: 'pve' }], evidence, [], []);
    expect(await adapter.test()).toMatchObject({
      authority: `proxmox:ca:${fingerprint}`,
      capabilities: { create: { available: true }, finance: { available: false } },
    });
    expect(request).toHaveBeenCalledWith('/api2/json/nodes/pve/certificates/info', undefined);
  });
  it('keeps endpoint aliases on one root CA together and rejects a leaf not signed by that CA', async () => {
    const evidence = await certificateEvidence();
    const first = fakeFor(
      { ...connection, baseUrl: 'https://pve-a.test:8006' },
      { version: '9.0' },
      [{ type: 'node', node: 'pve' }],
      evidence,
      [],
      []
    );
    const second = fakeFor(
      { ...connection, baseUrl: 'https://pve-b.test:8006' },
      { version: '9.0' },
      [{ type: 'node', node: 'pve' }],
      evidence,
      [],
      []
    );
    const firstAuthority = (await first.adapter.test()).authority;
    expect(firstAuthority).toBe((await second.adapter.test()).authority);
    const differentEvidence = await certificateEvidence();
    const differentCa = fakeFor(
      connection,
      { version: '9.0' },
      [{ type: 'node', node: 'pve' }],
      differentEvidence,
      [],
      []
    );
    expect((await differentCa.adapter.test()).authority).not.toBe(firstAuthority);
    const invalid = fake(
      { version: '9.0' },
      [{ type: 'node', node: 'pve' }],
      [evidence[0], { filename: 'pve-ssl.pem', pem: evidence[0].pem }],
      [],
      []
    );
    await expect(invalid.adapter.test()).rejects.toMatchObject({ code: 'HOSTING_CLUSTER_DISCOVERY_FAILED' });
  });
  it('clones only the selected clean Linux QEMU template and never provisions a CT', async () => {
    const { adapter, request } = fake(
      {
        template: 1,
        ostype: 'l26',
        agent: 'enabled=1',
        net0: 'virtio=AA:BB:CC:DD:EE:FF',
        scsi0: 'local:disk,size=16G',
        ide2: 'local:cloudinit',
      },
      '251',
      'UPID:pve:1:2:3:qmclone:251:user:'
    );
    expect(await adapter.create(input)).toMatchObject({ resourceId: '251', status: 'running' });
    expect(request).toHaveBeenLastCalledWith('/api2/json/nodes/pve/qemu/9000/clone', {
      method: 'POST',
      body: {
        newid: 251,
        name: input.name,
        full: 1,
        target: 'pve',
        storage: 'local-lvm',
        pool: 'gateway',
        description: 'Gateway hosting gw-operation-1',
      },
    });
    expect(request.mock.calls.every(([path]) => !String(path).includes('/lxc/'))).toBe(true);
  });
  it('rejects incomplete templates before reserving a VM ID or cloning', async () => {
    const { adapter, request } = fake({ template: 1, ostype: 'l26', ide2: 'local:cloudinit' });
    await expect(adapter.create(input)).rejects.toMatchObject({ code: 'HOSTING_TEMPLATE_NOT_READY' });
    expect(request).toHaveBeenCalledTimes(1);
    await expect(adapter.create({ ...input, image: 'another' })).rejects.toMatchObject({
      code: 'HOSTING_TEMPLATE_NOT_READY',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('does not silently choose another ID when the accepted pool reservation becomes occupied', async () => {
    const { adapter, request } = fake(
      {
        template: 1,
        ostype: 'l26',
        agent: 'enabled=1',
        net0: 'virtio=AA:BB:CC:DD:EE:FF',
        scsi0: 'local:disk,size=16G',
        ide2: 'local:cloudinit',
      },
      new HostingProviderError(400, false, 'occupied')
    );
    await expect(adapter.create(input)).rejects.toMatchObject({ code: 'HOSTING_VMID_IN_USE' });
    expect(request.mock.calls[1]).toEqual(['/api2/json/cluster/nextid', { query: { vmid: 251 } }]);
    expect(request.mock.calls.filter(([path]) => path.endsWith('/clone'))).toHaveLength(0);
  });
  it('never reports a running mismatched clone as configured', async () => {
    const { adapter, request } = fake();
    await expect(adapter.prepare({ ...resource, powerState: 'running', cpu: 1 }, input)).rejects.toMatchObject({
      code: 'HOSTING_VM_MUST_STOP',
    });
    expect(request).not.toHaveBeenCalled();
  });
  it('disables inherited filtering in a separate durable step before touching cloned NICs', async () => {
    const beforePreparation = vi.fn(async () => {});
    const { adapter, request } = fake(
      { net0: 'virtio=AA:BB:CC:DD:EE:FF', scsi0: 'local:disk,size=16G' },
      { enable: 1, digest: 'old' },
      null,
      { enable: 0 }
    );
    expect(await adapter.prepare(resource, { ...input, beforePreparation })).toMatchObject({
      preparationStage: 'firewall',
      status: 'succeeded',
    });
    expect(beforePreparation).toHaveBeenCalledWith('firewall');
    expect(request.mock.calls[2]).toEqual([
      '/api2/json/nodes/pve/qemu/250/firewall/options',
      { method: 'PUT', body: { enable: 0, digest: 'old' } },
    ]);
    expect(request.mock.calls.filter(([, options]) => options?.method)).toHaveLength(1);
  });
  it('grows a verified clone then starts without changing firewall or network again', async () => {
    const { adapter, request } = fake(
      { net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,firewall=1', scsi0: 'local:disk,size=16G' },
      { enable: 0 },
      null,
      'UPID:pve:start'
    );
    expect(await adapter.prepare(resource, { ...input, preparationStage: 'network' })).toMatchObject({
      preparationStage: 'start',
    });
    expect(request.mock.calls[2]).toEqual([
      '/api2/json/nodes/pve/qemu/250/resize',
      { method: 'PUT', body: { disk: 'scsi0', size: '32G' } },
    ]);
    expect(request.mock.calls[3][0]).toContain('/status/start');
  });
  it('prepares every cloned NIC without changing secondary adapter addressing or filtering rules', async () => {
    const { adapter, request } = fake(
      {
        net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=old',
        net1: 'e1000=11:22:33:44:55:66,bridge=private,tag=42,mtu=1400,firewall=0',
        scsi0: 'local:disk,size=32G',
      },
      { enable: 0, policy_in: 'DROP' },
      null,
      'UPID:pve:start'
    );
    await adapter.prepare(
      { ...resource, diskGb: 32 },
      { ...input, preparationStage: 'firewall', proxmox: { ...input.proxmox!, firewall: false } }
    );
    expect(request.mock.calls[2][1]?.body).toMatchObject({
      net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,firewall=1',
      net1: 'e1000=11:22:33:44:55:66,bridge=private,tag=42,mtu=1400,firewall=1',
    });
    expect(request.mock.calls.some(([path]) => String(path).endsWith('/firewall/rules'))).toBe(false);
  });
  it('never configures or starts a clone if disabling inherited firewall is rejected', async () => {
    const { adapter, request } = fake(
      { net0: 'virtio=AA:BB:CC:DD:EE:FF', scsi0: 'local:disk,size=32G' },
      { enable: 1 },
      new HostingProviderError(403, false, 'Permission denied')
    );
    await expect(adapter.prepare(resource, input)).rejects.toThrow('Permission denied');
    expect(
      request.mock.calls.some(([path, options]) => options?.method && !String(path).endsWith('/firewall/options'))
    ).toBe(false);
  });
  it('preserves CT identity and scoped private network evidence without QGA calls', async () => {
    const { adapter, request } = fake(
      [{ vmid: 250, node: 'pve', type: 'lxc', name: 'CT250', status: 'running', maxcpu: 2, maxmem: 2147483648 }],
      { meta: 'ctime=1234', net0: 'name=eth0,bridge=vmbr0,hwaddr=AA:BB:CC:DD:EE:FF,ip=10.0.0.5/24' },
      [{ name: 'eth0', hwaddr: 'AA:BB:CC:DD:EE:FF', inet: '10.0.0.5/24' }],
      { '/vms/250': { 'VM.Audit': 1 } }
    );
    const inventory = await adapter.listResources();
    expect(inventory.complete).toBe(true);
    expect(inventory.resources[0]).toMatchObject({
      kind: 'ct',
      remoteId: '250',
      incarnation: 'ctime:1234',
      addresses: [{ ip: '10.0.0.5', mac: 'AA:BB:CC:DD:EE:FF', network: 'vmbr0', direct: true }],
      capabilities: {
        bootstrap: { available: false },
        delete: { available: false, reason: 'Provider token lacks VM.Allocate on /vms/250' },
        shutdown: { available: false },
      },
    });
    expect(request.mock.calls.every(([path]) => !String(path).includes('/agent/'))).toBe(true);
  });
  it('distinguishes QGA reachability from execution rights and accepts non-propagated grants', async () => {
    const { adapter } = fake(
      [{ vmid: 250, node: 'pve', type: 'qemu', status: 'running' }],
      { agent: 1, smbios1: 'uuid=original' },
      { result: [] },
      { '/vms/250': { 'VM.PowerMgmt': 0, 'VM.GuestAgent.FileRead': 1, 'VM.GuestAgent.Audit': 1 } }
    );
    const vm = await adapter.getResource('250');
    expect(vm?.capabilities).toMatchObject({
      start: { available: true },
      guestIdentity: { available: true },
      recover: { available: false, reason: 'Provider token lacks VM.GuestAgent.Unrestricted on /vms/250' },
      bootstrap: { available: false },
      delete: { available: false },
      resize: { available: false },
    });
  });
  it('does not turn an inventory read failure into an empty complete inventory', async () => {
    const { adapter } = fake(
      [{ vmid: 250, node: 'pve', type: 'qemu' }],
      new HostingProviderError(403, false, 'denied')
    );
    await expect(adapter.listResources()).rejects.toMatchObject({ providerStatus: 403 });
  });
  it('polls only explicit successful UPID outcomes as success', async () => {
    const { adapter } = fake({ status: 'stopped', exitstatus: 'unexpected' }, { status: 'stopped', exitstatus: 'OK' });
    expect((await adapter.operation('UPID:pve:1:2:3:qmstart:250:user:', '250')).status).toBe('failed');
    expect((await adapter.operation('UPID:pve:1:2:3:qmstart:250:user:', '250')).status).toBe('succeeded');
  });
  it('keeps guest scripts out of process arguments and result errors', async () => {
    const { adapter, request } = fake({ pid: 42 }, { exited: 1, exitcode: 1, 'err-data': 'secret token' });
    const running = { ...resource, powerState: 'running' as const };
    const op = await adapter.bootstrap(running, '#!/bin/bash\necho sensitive');
    expect(request.mock.calls[0][1].body).toEqual({
      command: ['/bin/bash', '-s'],
      'input-data': '#!/bin/bash\necho sensitive',
    });
    expect(JSON.stringify(await adapter.operation(op.id!, resource.remoteId))).not.toContain('secret token');
    await expect(adapter.bootstrap({ ...running, kind: 'ct' }, 'script')).rejects.toMatchObject({
      code: 'HOSTING_GUEST_AGENT_REQUIRED',
    });
  });
  it('reads only the fixed Gateway identity path and requires shutdown before destruction', async () => {
    const identity = '11111111-1111-4111-8111-111111111111';
    const { adapter, request } = fake({ content: `${identity}\n` });
    expect(await adapter.guestIdentity({ ...resource, powerState: 'running' })).toBe(identity);
    expect(request.mock.calls[0][1]).toEqual({ query: { file: '/var/lib/gateway/host-identity' } });
    await expect(adapter.action({ ...resource, powerState: 'running' }, { action: 'delete' })).rejects.toMatchObject({
      code: 'HOSTING_VM_MUST_STOP',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
