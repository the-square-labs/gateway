import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import * as schema from '@/db/schema/index.js';
import type { User } from '@/types.js';
import { HostingFirewallService } from './hosting-firewall.service.js';
import { defaultHostingFirewall, type HostingFirewallObservation } from './hosting-firewall.types.js';
import { lockHostingFirewalls } from './hosting-firewall-lock.js';
import { HostingOperationsService } from './hosting-operations.service.js';
import { hostingCapabilities } from './hosting-provider.types.js';

const url = process.env.HOSTING_TEST_DATABASE_URL;
describe.skipIf(!url)('firewall PostgreSQL fences', () => {
  let pool: pg.Pool;
  let db: DrizzleClient;
  let service: HostingFirewallService;
  const actorId = randomUUID(),
    groupId = randomUUID(),
    connectorId = randomUUID(),
    resourceId = randomUUID(),
    nodeId = randomUUID(),
    hostId = randomUUID();
  const user = {
    id: actorId,
    scopes: ['nodes:details', 'nodes:config:edit', 'integrations:hosting:view', 'integrations:hosting:manage'],
  } as User;
  const snapshot = {
    remoteId: '123',
    kind: 'vm' as const,
    name: 'firewall-test',
    location: 'test',
    powerState: 'running' as const,
    cpu: 1,
    memoryMb: 1024,
    diskGb: 10,
    addresses: [],
    incarnation: 'original',
    capabilities: hostingCapabilities({}),
    observedAt: new Date().toISOString(),
  };
  const observation: HostingFirewallObservation = {
    fingerprint: 'initial',
    enabled: false,
    matches: true,
    applying: false,
    remoteId: null,
    blockers: [],
    observedAt: new Date().toISOString(),
  };
  const firewall = { read: vi.fn(async () => ({ ...observation })), apply: vi.fn(async () => {}) };
  let cached: unknown = null;
  beforeAll(async () => {
    const target = new URL(url!);
    if (target.hostname !== '127.0.0.1' || !/^\/hosting_test_firewall_[a-z0-9_]+$/.test(target.pathname))
      throw new Error('Disposable firewall test DB required');
    pool = new pg.Pool({ connectionString: url, max: 6, connectionTimeoutMillis: 5000 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await db.insert(schema.permissionGroups).values({ id: groupId, name: `firewall-${groupId}`, scopes: user.scopes });
    await db
      .insert(schema.users)
      .values({ id: actorId, groupId, name: 'Firewall test', email: `${actorId}@firewall.test` });
    const [connector] = await db
      .insert(schema.integrationConnectors)
      .values({
        id: connectorId,
        provider: 'digitalocean',
        name: 'Firewall test',
        baseUrl: 'https://api.digitalocean.com',
        enabled: true,
      })
      .returning();
    await db.insert(schema.hostingResources).values({
      id: resourceId,
      connectorId,
      provider: 'digitalocean',
      authority: 'firewall-test',
      remoteId: '123',
      kind: 'vm',
      origin: 'created',
      managedHostIdentity: hostId,
      incarnation: snapshot.incarnation,
      snapshot,
      observedAt: new Date(),
    });
    await db.insert(schema.nodes).values({
      id: nodeId,
      hostname: 'firewall-test',
      slug: `firewall-${nodeId}`,
      hostIdentityId: hostId,
      status: 'online',
    });
    await db.insert(schema.hostingNodeBindings).values({
      nodeId,
      resourceId,
      hostIdentityId: hostId,
      evidenceType: 'test',
      evidenceDigest: 'test',
      observedAt: new Date(),
    });
    service = new HostingFirewallService(
      db,
      {
        get: async () => connector,
        owner: async () => user,
        settings: () => ({ resourceIds: [] }),
        changed: vi.fn(),
        adapter: (_row: unknown, fence: () => Promise<void>) => ({
          firewall,
          getResource: async () => {
            await fence();
            return snapshot;
          },
        }),
      } as never,
      {
        get: async () => (cached ? { data: cached } : null),
        replace: async (_kind: string, _id: string, data: unknown) => {
          cached = data;
        },
      } as never,
      { getUserById: async () => user } as never,
      { log: vi.fn() } as never
    );
    await service.reconcileDue();
  }, 120000);
  afterAll(async () => {
    await pool?.end();
  });

  const current = async () =>
    (await db.select().from(schema.hostingFirewalls).where(eq(schema.hostingFirewalls.resourceId, resourceId)))[0]!;
  const save = async (enabled = false) => {
    const row = await current();
    return service.update(
      nodeId,
      {
        config: { ...defaultHostingFirewall(), enabled },
        expectedRevision: row.revision,
        expectedFingerprint: row.observation!.fingerprint,
        acknowledgeConnectivityRisk: true,
      },
      user
    );
  };
  it('initializes durable disabled state and makes no remote write', async () => {
    expect(await current()).toMatchObject({ revision: 0, status: 'ready', config: { enabled: false } });
    expect(firewall.apply).not.toHaveBeenCalled();
  });
  it('admits only one simultaneous save', async () => {
    const row = await current();
    const request = {
      config: defaultHostingFirewall(),
      expectedRevision: row.revision,
      expectedFingerprint: row.observation!.fingerprint,
      acknowledgeConnectivityRisk: true,
    };
    const result = await Promise.allSettled(Array.from({ length: 4 }, () => service.update(nodeId, request, user)));
    expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect((await current()).revision).toBe(1);
    await service.reconcileDue();
    expect((await current()).status).toBe('ready');
  });
  it('blocks VM operation reservation while firewall intent is pending', async () => {
    await save();
    const operations = new HostingOperationsService(db, { publish: vi.fn() } as never);
    await expect(
      operations.reserve({
        connectorId,
        resourceId,
        actorId,
        action: 'shutdown',
        idempotencyKey: randomUUID(),
        request: {},
      })
    ).rejects.toMatchObject({ code: 'HOSTING_FIREWALL_BUSY' });
    await service.reconcileDue();
  });
  it('honors another process owning the advisory lock', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`hosting-firewall:${resourceId}`}))`);
      await expect(save()).rejects.toThrow('synchronizing');
      await expect(db.transaction((other) => lockHostingFirewalls(other, [resourceId]))).rejects.toMatchObject({
        code: 'HOSTING_FIREWALL_BUSY',
      });
    });
  });
  it('connector and node lifecycle refuse to detach a resource with accepted firewall changes', async () => {
    await save();
    await expect(db.transaction((tx) => lockHostingFirewalls(tx, [resourceId]))).rejects.toMatchObject({
      code: 'HOSTING_FIREWALL_BUSY',
    });
    await service.reconcileDue();
    await expect(db.transaction((tx) => lockHostingFirewalls(tx, [resourceId]))).resolves.toBeUndefined();
  });
  it('commits dispatch evidence before provider IO and never replays an unknown outcome', async () => {
    await save(true);
    observation.matches = false;
    firewall.apply.mockImplementation(async () => {
      expect(await current()).toMatchObject({ status: 'applying', dispatchedAt: expect.any(Date) });
      throw new Error('Lost response');
    });
    await service.reconcileDue();
    expect(await current()).toMatchObject({ status: 'failed', dispatchedAt: expect.any(Date) });
    await db
      .update(schema.hostingFirewalls)
      .set({ observedAt: null })
      .where(eq(schema.hostingFirewalls.resourceId, resourceId));
    await service.reconcileDue();
    expect(firewall.apply).toHaveBeenCalledOnce();
    expect((await current()).status).toBe('failed');
  });
});
