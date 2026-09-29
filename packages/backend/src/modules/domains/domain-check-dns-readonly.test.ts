// The schema barrel first, in its production order: the per-table modules import each other circularly.
import '@/db/schema/index.js';
import { describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import type { domains } from '@/db/schema/domains.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { DomainsService } from './domain.service.js';

vi.mock('./dns.utils.js', () => ({
  probeDnsRecords: vi.fn(async () => ({
    records: { a: ['203.0.113.99'], aaaa: [], cname: [], caa: [], mx: [], txt: [] },
    addressResolution: 'resolved',
  })),
}));

const DOMAIN_ID = '22222222-2222-4222-8222-222222222222';
const NODE_ID = '11111111-1111-4111-8111-111111111111';

type DomainRow = typeof domains.$inferSelect;

/** A Cloudflare-managed domain whose tracked record drifted and which still has an approved pending target. */
function driftedRow(): DomainRow {
  return {
    id: DOMAIN_ID,
    domain: 'app.example.com',
    dnsProvider: 'cloudflare',
    nginxNodeId: NODE_ID,
    ingressGroupId: null,
    integrationConnectorId: 'connector-1',
    providerZoneId: 'zone-1',
    providerRecordIds: ['record-1'],
    dnsTargetIps: ['203.0.113.10'],
    pendingDnsTargetIp: '203.0.113.10',
    dnsRecordType: 'A',
    dnsTtl: 1,
    dnsProxied: false,
    dnsStatus: 'valid',
  } as unknown as DomainRow;
}

function setup() {
  const row = driftedRow();
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) })),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        const where = () => Object.assign(Promise.resolve(), { returning: async () => [{ ...row, ...values }] });
        return { where };
      },
    })),
  };
  const client = {
    listDnsRecords: vi.fn(async () => [
      { id: 'record-1', type: 'A', name: 'app.example.com', content: '203.0.113.99', ttl: 1, proxied: false },
    ]),
    createDnsRecord: vi.fn(async () => ({ id: 'record-2' })),
    updateDnsRecord: vi.fn(async () => ({ id: 'record-1' })),
    deleteDnsRecord: vi.fn(async () => undefined),
  };
  const integrations = {
    getCloudflareDnsContextForRecord: vi.fn(async () => ({ zone: { remoteId: 'zone-1' }, client })),
  };
  const audit = { log: vi.fn(async () => undefined) };
  const service = new DomainsService(db as unknown as DrizzleClient, audit as unknown as AuditService);
  service.setIntegrationsService(integrations as unknown as IntegrationsService);
  vi.spyOn(service, 'getNginxNodeOptions').mockResolvedValue({
    eligibleNodes: [
      {
        id: NODE_ID,
        slug: 'edge',
        hostname: 'edge',
        displayName: null,
        appearanceColor: null,
        effectiveAddress: '203.0.113.10',
        effectiveAddresses: ['203.0.113.10'],
      },
    ],
    unconfiguredNodes: [],
    totalNginxNodes: 1,
    unconfiguredNginxNodes: 0,
  });
  return { service, client, updates, audit };
}

describe('DomainsService.checkDns with repair false', () => {
  it('reads the provider but never writes a record or the reconciled target', async () => {
    const { service, client, updates, audit } = setup();

    const result = await service.checkDns(DOMAIN_ID, { repair: false });

    expect(client.listDnsRecords).toHaveBeenCalled();
    expect(client.createDnsRecord).not.toHaveBeenCalled();
    expect(client.updateDnsRecord).not.toHaveBeenCalled();
    expect(client.deleteDnsRecord).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    // Only the observation is stored: status, observed records and the check time.
    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0]).sort()).toEqual(['dnsRecords', 'dnsStatus', 'lastDnsCheckAt', 'updatedAt']);
    expect(result.dnsStatus).toBe('invalid');
  });

  it('still repairs the drifted record when repair is not disabled', async () => {
    const { service, client } = setup();

    await service.checkDns(DOMAIN_ID);

    expect(client.updateDnsRecord).toHaveBeenCalledWith(
      'zone-1',
      'record-1',
      expect.objectContaining({ content: '203.0.113.10' })
    );
  });
});
