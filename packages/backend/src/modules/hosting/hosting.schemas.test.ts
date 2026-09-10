import { describe, expect, it } from 'vitest';
import {
  CreateHostingConnectorSchema,
  HostingActionSchema,
  HostingProvisionSchema,
  HostingSettingsSchema,
  HostingTopupSchema,
} from './hosting.schemas.js';

const id = '11111111-1111-4111-8111-111111111111';
describe('hosting input contracts', () => {
  it.each([
    '5.9900000000000000',
    '0.00000000000001',
  ])('admits exact provider quotes for create and resize: %s', (amount) => {
    const confirmedPrice = { amount, currency: 'USD' };
    const provision = {
      connectorId: id,
      idempotencyKey: id,
      name: 'worker',
      role: 'docker',
      location: 'fsn1',
      size: '22',
      image: 'ubuntu-22.04',
      confirmedPrice,
    };
    expect(HostingProvisionSchema.parse(provision).confirmedPrice).toEqual(confirmedPrice);
    expect(
      HostingActionSchema.parse({
        idempotencyKey: id,
        action: 'resize',
        expectedIncarnation: 'server-1',
        size: '22',
        confirmed: true,
        confirmedPrice,
      }).confirmedPrice
    ).toEqual(confirmedPrice);
    const rejected = HostingProvisionSchema.safeParse({
      ...provision,
      confirmedPrice: { ...confirmedPrice, amount: 'NaN' },
    });
    expect(rejected.success).toBe(false);
    if (!rejected.success)
      expect(rejected.error.issues[0]).toMatchObject({
        path: ['confirmedPrice', 'amount'],
        message: 'Provider quote amount must be a non-negative decimal',
      });
  });
  it('uses hosting defaults without Git settings', () => {
    const settings = HostingSettingsSchema.parse({});
    expect(settings).toMatchObject({ kind: 'hosting', autoSyncEnabled: true, adoptionEnabled: true });
    expect(settings).not.toHaveProperty('cloneDepth');
    expect(HostingSettingsSchema.safeParse({ cloneDepth: 1 }).success).toBe(false);
  });
  it('pins public cloud connections to their official HTTPS origins', () => {
    const connector = {
      provider: 'digitalocean',
      name: 'DO',
      token: 'secret',
      baseUrl: 'https://api.digitalocean.com',
      settings: {},
    };
    expect(CreateHostingConnectorSchema.safeParse(connector).success).toBe(true);
    for (const baseUrl of [
      'http://api.digitalocean.com',
      'https://evil.test',
      'https://secret@api.digitalocean.com',
      'https://api.digitalocean.com/path',
    ]) {
      expect(CreateHostingConnectorSchema.safeParse({ ...connector, baseUrl }).success).toBe(false);
    }
    expect(
      CreateHostingConnectorSchema.safeParse({ ...connector, settings: { certificateFingerprint: 'a'.repeat(64) } })
        .success
    ).toBe(false);
  });
  it('requires Proxmox token identity and one selected physical host while allowing inventory without a profile', () => {
    const connector = {
      provider: 'proxmox',
      name: 'Lab',
      token: 'secret',
      baseUrl: 'https://pve.test:8006',
      settings: {},
    };
    expect(CreateHostingConnectorSchema.safeParse(connector).success).toBe(false);
    expect(
      CreateHostingConnectorSchema.safeParse({
        ...connector,
        settings: { tokenId: 'gateway@pve!hosting', proxmoxHost: 'pve-a' },
      }).success
    ).toBe(true);
  });
  it('normalizes bounded mixed Proxmox pools and rejects static pool holes', () => {
    const result = CreateHostingConnectorSchema.safeParse({
      provider: 'proxmox',
      name: 'Lab',
      token: 'secret',
      baseUrl: 'https://pve.test:8006',
      settings: {
        tokenId: 'gateway@pve!hosting',
        proxmoxHost: 'pve-a',
        proxmox: {
          nodes: ['pve-a'],
          templateId: 9000,
          templateNode: 'pve-a',
          storage: 'local-lvm',
          imageStorage: 'local',
          seedStorage: 'local',
          bridge: 'vmbr0',
          pool: 'gateway',
          cleanTemplate: true,
          vmidRange: '273-280,250-260,271,250',
          network: 'static',
          subnet: '10.0.0.0/24',
          gateway: '10.0.0.1',
          ipRange: '10.0.0.10-10.0.0.29',
          vlan: null,
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.settings.proxmox?.vmidRange).toBe('250-260,271,273-280');
    expect(
      CreateHostingConnectorSchema.safeParse({
        provider: 'proxmox',
        name: 'bad',
        token: 'secret',
        baseUrl: 'https://pve.test:8006',
        settings: {
          tokenId: 'gateway@pve!hosting',
          proxmoxHost: 'pve-a',
          proxmox: {
            nodes: ['pve-a'],
            templateId: 9000,
            templateNode: 'pve-a',
            storage: 'local-lvm',
            bridge: 'vmbr0',
            pool: 'gateway',
            cleanTemplate: true,
            vmidRange: '250-260',
            network: 'static',
            subnet: '10.0.0.0/24',
            gateway: '10.0.0.1',
            ipRange: '10.0.0.0,10.0.0.2',
          },
        },
      }).success
    ).toBe(false);
  });
  it('rejects action payloads that bypass confirmation, incarnation, or the action allowlist', () => {
    const action = { idempotencyKey: id, action: 'reboot', expectedIncarnation: 'created-1', confirmed: true };
    expect(HostingActionSchema.safeParse(action).success).toBe(true);
    expect(HostingActionSchema.safeParse({ ...action, confirmed: false }).success).toBe(false);
    expect(HostingActionSchema.safeParse({ ...action, expectedIncarnation: '' }).success).toBe(false);
    expect(HostingActionSchema.safeParse({ ...action, action: 'reinstall' }).success).toBe(false);
    expect(HostingActionSchema.safeParse({ ...action, action: 'resize' }).success).toBe(false);
  });
  it('accepts only exact decimal topup amounts and supported node roles', () => {
    for (const amount of ['0', '-1', '1e3', 'NaN', '1.234', '01.00']) {
      expect(
        HostingTopupSchema.safeParse({ idempotencyKey: id, amount, currency: 'USD', confirmed: true }).success
      ).toBe(false);
    }
    expect(
      HostingTopupSchema.safeParse({ idempotencyKey: id, amount: '10.50', currency: 'USD', confirmed: true }).success
    ).toBe(true);
    const create = {
      connectorId: id,
      idempotencyKey: id,
      name: 'docker-1',
      role: 'docker',
      location: 'eu',
      size: 'small',
      image: 'ubuntu',
    };
    expect(HostingProvisionSchema.safeParse(create).success).toBe(true);
    expect(HostingProvisionSchema.safeParse({ ...create, name: 'node; curl evil' }).success).toBe(false);
    expect(HostingProvisionSchema.safeParse({ ...create, role: 'bastion' }).success).toBe(false);
  });
});

it('separates display names from strict provider hostnames with legacy request compatibility', () => {
  const input = {
    connectorId: id,
    idempotencyKey: id,
    name: 'build-worker',
    role: 'builder',
    location: 'pve',
    size: 'custom',
    image: 'ubuntu',
  };
  expect(HostingProvisionSchema.parse({ ...input, displayName: 'Сборочный сервер 2' })).toMatchObject({
    name: 'build-worker',
    displayName: 'Сборочный сервер 2',
  });
  expect(HostingProvisionSchema.parse(input).name).toBe('build-worker');
  for (const name of ['bad name', '-worker', 'worker-', 'a'.repeat(64), 'сервер', 'host.example'])
    expect(HostingProvisionSchema.safeParse({ ...input, name }).success).toBe(false);
  for (const displayName of [' ', 'a'.repeat(256)])
    expect(HostingProvisionSchema.safeParse({ ...input, displayName }).success).toBe(false);
});
