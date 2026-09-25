import { describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { assertNodeDomainDnsUpdateAccess } from './domain-dns-access.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const DOMAIN_A = '22222222-2222-4222-8222-222222222222';
const DOMAIN_B = '33333333-3333-4333-8333-333333333333';

function fakeDb(domainIds: string[]) {
  const where = vi.fn(async () => domainIds.map((id) => ({ id })));
  const db = { select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })) };
  return { db: db as unknown as DrizzleClient, select: db.select };
}

describe('assertNodeDomainDnsUpdateAccess', () => {
  it('accepts broad domain edit access without looking up the assigned domains', async () => {
    const { db, select } = fakeDb([DOMAIN_A]);

    await expect(assertNodeDomainDnsUpdateAccess(NODE_ID, ['domains:edit'], db)).resolves.toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });

  it('refuses a caller without any domain edit grant before querying', async () => {
    const { db, select } = fakeDb([DOMAIN_A]);

    await expect(assertNodeDomainDnsUpdateAccess(NODE_ID, ['nodes:manage'], db)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(select).not.toHaveBeenCalled();
  });

  it('accepts per-domain grants that cover every domain assigned to the node', async () => {
    const { db } = fakeDb([DOMAIN_A, DOMAIN_B]);

    await expect(
      assertNodeDomainDnsUpdateAccess(NODE_ID, [`domains:edit:${DOMAIN_A}`, `domains:edit:${DOMAIN_B}`], db)
    ).resolves.toBeUndefined();
  });

  it('refuses when one assigned domain is outside the per-domain grants', async () => {
    const { db } = fakeDb([DOMAIN_A, DOMAIN_B]);

    await expect(assertNodeDomainDnsUpdateAccess(NODE_ID, [`domains:edit:${DOMAIN_A}`], db)).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredScope: `domains:edit:${DOMAIN_B}`, deniedDomainCount: 1 },
    });
  });
});
