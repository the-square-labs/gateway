import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import * as schema from '@/db/schema/index.js';
import { ResourceSnapshotStore } from '@/services/resource-snapshot.store.js';
import type { User } from '@/types.js';
import { HostingSettingsSchema } from './hosting.schemas.js';
import {
  type HostingConnectorRow,
  HostingConnectorsService,
  type StoredHostingSettings,
} from './hosting-connectors.service.js';
import { HostingInventoryService } from './hosting-inventory.service.js';
import { type HostingOperationRow, HostingOperationsService } from './hosting-operations.service.js';
import {
  type HostingConnection,
  type HostingProviderAdapter,
  type HostingResourceSnapshot,
  hostingCapabilities,
} from './hosting-provider.types.js';
import { HostingProvisioningService } from './hosting-provisioning.service.js';
import { snapshotFolderService, snapshotLayoutId, snapshotPlacements } from './hosting-snapshot-folders.js';
import { allocateProxmoxPool } from './proxmox-allocation.js';

const url = process.env.HOSTING_TEST_DATABASE_URL;

/** Opt-in only. The runner provisions a disposable DB on the explicitly authorized E2E stand. */
describe.skipIf(!url)('hosting PostgreSQL transaction invariants', () => {
  let pool: pg.Pool;
  let db: DrizzleClient;
  let first: HostingOperationsService;
  let second: HostingOperationsService;
  const actorId = randomUUID();
  const groupId = randomUUID();
  const connectorId = randomUUID();
  const resourceId = randomUUID();
  const hostId = randomUUID();
  const nodeIds = [randomUUID(), randomUUID()];
  const events = { publish: vi.fn() };

  it('serializes provider identity allocation with a nonblocking authority lock across connections', async () => {
    const key = `hosting-create:${connectorId}`;
    await db.transaction(async (owner) => {
      const acquired = await owner.execute<{ acquired: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS acquired`
      );
      expect(acquired.rows[0].acquired).toBe(true);
      await db.transaction(async (competitor) => {
        const denied = await competitor.execute<{ acquired: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS acquired`
        );
        expect(denied.rows[0].acquired).toBe(false);
      });
    });
    await db.transaction(async (next) => {
      const acquired = await next.execute<{ acquired: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS acquired`
      );
      expect(acquired.rows[0].acquired).toBe(true);
    });
  });

  beforeAll(async () => {
    const target = new URL(url!);
    if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !/^\/hosting_test_[a-z0-9_]+$/.test(target.pathname))
      throw new Error('Hosting DB tests require a dedicated hosting_test_ database through a local tunnel');
    pool = new pg.Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5000 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await db.insert(schema.permissionGroups).values({ id: groupId, name: `hosting-test-${groupId}`, scopes: [] });
    await db
      .insert(schema.users)
      .values({ id: actorId, groupId, email: `${actorId}@hosting.test`, name: 'Hosting test user' });
    await db.insert(schema.integrationConnectors).values({
      id: connectorId,
      provider: 'proxmox',
      name: `Hosting ${connectorId}`,
      baseUrl: 'https://pve.test:8006',
      settings: {
        kind: 'hosting',
        resourceIds: [],
        adoptionNodeIds: [],
        adoptionEnabled: false,
        autoSyncEnabled: false,
        autoSyncIntervalSeconds: 300,
      },
    });
    await db.insert(schema.hostingResources).values({
      id: resourceId,
      connectorId,
      provider: 'proxmox',
      authority: 'test-cluster',
      remoteId: randomUUID(),
      kind: 'vm',
      origin: 'created',
      managedHostIdentity: hostId,
      incarnation: 'guest-original',
      observedAt: new Date(),
      snapshot: {
        remoteId: '250',
        kind: 'vm',
        name: 'test',
        location: 'test',
        powerState: 'running',
        cpu: 1,
        memoryMb: 1024,
        diskGb: 8,
        incarnation: 'guest-original',
        addresses: [],
        capabilities: hostingCapabilities({}),
        observedAt: new Date().toISOString(),
      },
    });
    await db
      .insert(schema.nodes)
      .values(nodeIds.map((id) => ({ id, hostname: `test-${id}`, slug: `test-${id}`, hostIdentityId: hostId })));
    first = new HostingOperationsService(db, events as never);
    second = new HostingOperationsService(db, events as never);
  }, 120000);
  afterAll(async () => {
    await pool?.end();
  });

  it('reserves one intent and runs quota/node initialization once under concurrent clicks', async () => {
    const idempotencyKey = randomUUID();
    const initialize = vi.fn(async () => ({}));
    const request = {
      connectorId,
      actorId,
      action: 'create' as const,
      idempotencyKey,
      request: { name: 'one-order', idempotencyKey },
    };
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => (index % 2 ? first : second).reserve(request, initialize))
    );
    expect(new Set(results.map((result) => result.operation.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(initialize).toHaveBeenCalledOnce();
    const replay = await first.reserve({
      ...request,
      idempotencyKey: randomUUID(),
      request: { ...request.request, idempotencyKey: randomUUID() },
    });
    expect(replay.operation.id).toBe(results[0].operation.id);
    await expect(first.reserve({ ...request, request: { name: 'different-order' } })).rejects.toMatchObject({
      code: 'HOSTING_INTENT_CONFLICT',
    });
  });

  it('rolls back node creation when operation admission fails', async () => {
    const nodeId = randomUUID();
    await expect(
      first.reserve(
        { connectorId, actorId, action: 'create', idempotencyKey: randomUUID(), request: { name: 'rollback' } },
        async (tx) => {
          await tx.insert(schema.nodes).values({ id: nodeId, hostname: 'rollback', slug: `rollback-${nodeId}` });
          throw new Error('Simulated quota/admission failure');
        }
      )
    ).rejects.toThrow('Simulated quota/admission failure');
    expect(await db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId))).toHaveLength(0);
  });
  it('persists VM-scoped snapshot folders, rejects foreign parents, and ungroups rather than deleting snapshots', async () => {
    const [original] = await db
      .select()
      .from(schema.hostingResources)
      .where(eq(schema.hostingResources.id, resourceId));
    const otherId = randomUUID();
    await db
      .insert(schema.hostingResources)
      .values({ ...original, id: otherId, remoteId: randomUUID(), managedHostIdentity: randomUUID() });
    const audit = { log: vi.fn() } as never;
    const own = snapshotFolderService(db, audit, resourceId),
      other = snapshotFolderService(db, audit, otherId);
    const folder = await own.createFolder({ name: 'Before upgrades' }, actorId);
    const child = await own.createFolder({ name: 'September', parentId: folder.id }, actorId);
    expect(await other.getFolderTree({ includeAllFolders: true })).toEqual([]);
    await expect(other.createFolder({ name: 'Invalid', parentId: folder.id }, actorId)).rejects.toMatchObject({
      code: 'FOLDER_NOT_FOUND',
    });
    await expect(other.updateFolder(folder.id, { name: 'stolen' }, actorId)).rejects.toMatchObject({
      code: 'FOLDER_NOT_FOUND',
    });
    const fingerprint = 'a'.repeat(64),
      layoutId = snapshotLayoutId(resourceId, fingerprint);
    await db
      .insert(schema.hostingSnapshotPlacements)
      .values({ id: layoutId, resourceId, snapshotId: '100', fingerprint });
    await own.moveResourcesToFolder({ ids: [layoutId], folderId: child.id }, actorId);
    const snapshot = {
      id: '100',
      name: 'Before',
      fingerprint,
      createdAt: null,
      sizeGb: 2,
      minDiskGb: null,
      ready: true,
    };
    expect((await snapshotPlacements(db, resourceId, [snapshot]))[0].folderId).toBe(child.id);
    expect(snapshotLayoutId(otherId, fingerprint)).not.toBe(layoutId);
    await own.deleteFolder(folder.id, actorId);
    expect((await snapshotPlacements(db, resourceId, [snapshot]))[0].folderId).toBeNull();
    expect(
      await db.select().from(schema.hostingSnapshotPlacements).where(eq(schema.hostingSnapshotPlacements.id, layoutId))
    ).toHaveLength(1);
  });

  it('serializes snapshots with VM actions and releases the VM after a definite snapshot failure', async () => {
    const [original] = await db
      .select()
      .from(schema.hostingResources)
      .where(eq(schema.hostingResources.id, resourceId));
    const targetId = randomUUID();
    await db
      .insert(schema.hostingResources)
      .values({ ...original, id: targetId, remoteId: randomUUID(), managedHostIdentity: randomUUID() });
    const reserved = await first.reserve({
      connectorId,
      resourceId: targetId,
      actorId,
      action: 'snapshot_restore',
      idempotencyKey: randomUUID(),
      request: { snapshotId: 'before' },
    });
    await expect(
      second.reserve({
        connectorId,
        resourceId: targetId,
        actorId,
        action: 'delete',
        idempotencyKey: randomUUID(),
        request: {},
      })
    ).rejects.toMatchObject({ code: 'HOSTING_RESOURCE_BUSY' });
    const lease = (await first.claim(reserved.operation.id))!;
    const dispatched = await first.dispatch(lease, 'dispatching');
    await first.finish(dispatched, 'failed', undefined, {
      code: 'HOSTING_PROVIDER_ERROR',
      message: 'Permission denied',
    });
    expect(
      (
        await second.reserve({
          connectorId,
          resourceId: targetId,
          actorId,
          action: 'snapshot_create',
          idempotencyKey: randomUUID(),
          request: { name: 'retry' },
        })
      ).created
    ).toBe(true);
  });

  it('fences stale leases, and a recovered lease cannot repeat the dispatch boundary', async () => {
    const result = await first.reserve({
      connectorId,
      actorId,
      action: 'create',
      idempotencyKey: randomUUID(),
      request: { name: 'fence' },
    });
    const owned = (await first.claim(result.operation.id))!;
    expect(await second.claim(owned.id)).toBeNull();
    const sent = await first.dispatch(owned, 'dispatching');
    await db
      .update(schema.hostingOperations)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.hostingOperations.id, owned.id));
    const recovered = (await second.claim(owned.id))!;
    expect(recovered.generation).toBeGreaterThan(owned.generation);
    await expect(first.update(sent, { phase: 'ready' })).rejects.toMatchObject({
      code: 'HOSTING_OPERATION_LEASE_LOST',
    });
    await expect(second.dispatch(recovered, 'dispatching')).rejects.toMatchObject({
      code: 'HOSTING_DISPATCH_ALREADY_STARTED',
    });
    expect(recovered.result?.dispatchStage).toBe('dispatching');
  });

  it('persists one credit attempt across lease reclaim and rejects changed order identities', async () => {
    const payment = { invoiceId: '900', amount: '6.47', currency: 'USD' };
    const [connector] = await db
      .select()
      .from(schema.integrationConnectors)
      .where(eq(schema.integrationConnectors.id, connectorId));
    const reserved = await first.reserve({
      connectorId,
      actorId,
      action: 'create',
      idempotencyKey: randomUUID(),
      request: { name: 'credit-fence' },
    });
    let owned = (await first.claim(reserved.operation.id))!;
    owned = await first.update(owned, {
      nodeId: nodeIds[0],
      phase: 'awaiting_payment',
      encryptedBootstrap: 'test',
      bootstrapExpiresAt: new Date(Date.now() + 3600000),
      providerOperation: { id: null, status: 'awaiting_payment', invoiceId: '900' },
    });
    await expect(first.dispatchOrderCredit(owned, connector, { ...payment, invoiceId: '901' })).rejects.toMatchObject({
      code: 'HOSTING_CREDIT_DISPATCH_BLOCKED',
    });
    await expect(
      first.dispatchOrderCredit(owned, { ...connector, updatedAt: new Date(0) }, payment)
    ).rejects.toMatchObject({ code: 'HOSTING_CREDIT_DISPATCH_BLOCKED' });
    const sent = await first.dispatchOrderCredit(owned, connector, payment);
    expect(sent.result?.creditPayment).toMatchObject(payment);
    await expect(first.dispatchOrderCredit(sent, connector, payment)).rejects.toMatchObject({
      code: 'HOSTING_CREDIT_DISPATCH_BLOCKED',
    });
    await db
      .update(schema.hostingOperations)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.hostingOperations.id, owned.id));
    const recovered = (await second.claim(owned.id))!;
    await expect(second.dispatchOrderCredit(recovered, connector, payment)).rejects.toMatchObject({
      code: 'HOSTING_CREDIT_DISPATCH_BLOCKED',
    });
    await second.finish(recovered, 'failed');
  });

  it('permits several roles on one host but rejects mismatched host/resource bindings', async () => {
    const common = {
      resourceId,
      hostIdentityId: hostId,
      evidenceType: 'guest_identity',
      evidenceDigest: 'test-proof',
      observedAt: new Date(),
    };
    await db.insert(schema.hostingNodeBindings).values(nodeIds.map((nodeId) => ({ ...common, nodeId })));
    expect(
      await db.select().from(schema.hostingNodeBindings).where(eq(schema.hostingNodeBindings.resourceId, resourceId))
    ).toHaveLength(2);
    const third = randomUUID();
    await db.insert(schema.nodes).values({ id: third, hostname: 'third', slug: `third-${third}` });
    await expect(
      db.insert(schema.hostingNodeBindings).values({ ...common, nodeId: third, hostIdentityId: randomUUID() })
    ).rejects.toThrow();
    await expect(
      db.execute(sql`UPDATE hosting_resources SET managed_host_identity = ${randomUUID()} WHERE id = ${resourceId}`)
    ).rejects.toThrow();
  });

  it('preserves resource bindings when the account is detached', async () => {
    const detached = randomUUID();
    const other = randomUUID();
    await db.insert(schema.integrationConnectors).values({
      id: detached,
      provider: 'digitalocean',
      name: `Detach ${detached}`,
      baseUrl: 'https://api.digitalocean.com',
    });
    const [source] = await db.select().from(schema.hostingResources).where(eq(schema.hostingResources.id, resourceId));
    await db
      .insert(schema.hostingResources)
      .values({ ...source, id: other, connectorId: detached, remoteId: randomUUID(), managedHostIdentity: null });
    await db.delete(schema.integrationConnectors).where(eq(schema.integrationConnectors.id, detached));
    const [preserved] = await db.select().from(schema.hostingResources).where(eq(schema.hostingResources.id, other));
    expect(preserved.connectorId).toBeNull();
    expect(preserved.incarnation).toBe('guest-original');
  });

  it('does not expose VM finance or action authority through node-read permission', async () => {
    const [source] = await db.select().from(schema.hostingResources).where(eq(schema.hostingResources.id, resourceId));
    await db
      .update(schema.hostingResources)
      .set({
        provider: 'digitalocean',
        snapshot: { ...source.snapshot, price: { amount: '12', currency: 'USD', estimated: true } },
      })
      .where(eq(schema.hostingResources.id, resourceId));
    const inventory = new HostingInventoryService(db, {} as never, {} as never, {} as never, {} as never);
    const readOnly = { id: actorId, scopes: [`nodes:details:${nodeIds[0]}`] } as User;
    const view = await inventory.nodeProjection(nodeIds[0], readOnly);
    expect(view?.price).toBeUndefined();
    expect(view?.actions.delete.available).toBe(false);
    const finance = await inventory.nodeProjection(nodeIds[0], {
      ...readOnly,
      scopes: [...readOnly.scopes, `hosting:billing:view:${connectorId}`],
    });
    expect(finance?.price?.amount).toBe('12');
    await expect(inventory.nodeProjection(nodeIds[1], readOnly)).rejects.toMatchObject({
      code: 'HOSTING_ACCESS_DENIED',
    });
  });

  async function account(provider: 'hostkey' | 'hetzner' | 'proxmox', overrides: Partial<StoredHostingSettings> = {}) {
    const id = randomUUID();
    const settings = {
      ...HostingSettingsSchema.parse({ adoptionEnabled: false }),
      authority: `test-${id}`,
      ownerId: actorId,
      accountName: 'test',
      ...overrides,
    };
    const [row] = await db
      .insert(schema.integrationConnectors)
      .values({
        id,
        provider,
        name: `test-${id}`,
        baseUrl: 'https://pve.test:8006',
        encryptedToken: JSON.stringify({ value: 'original-token' }),
        settings,
      })
      .returning();
    return row;
  }
  const crypto = {
    decryptString: (value: { value: string }) => value.value,
    encryptString: (value: string) => ({ value }),
  };
  const audit = { log: vi.fn(async () => true) };
  const owner = {
    id: actorId,
    scopes: [
      'integrations:hosting:manage',
      'hosting:resources:create',
      'nodes:create',
      'nodes:details',
      'nodes:config:edit',
    ],
  } as User;
  const auth = { getUserById: vi.fn(async () => owner) };
  function connectors(adapter: Partial<HostingProviderAdapter> = {}) {
    return new HostingConnectorsService(
      db,
      crypto as never,
      audit as never,
      events as never,
      auth,
      () => adapter as HostingProviderAdapter
    );
  }
  async function insertResource(connector: HostingConnectorRow, patch: Partial<HostingResourceSnapshot> = {}) {
    const snapshot: HostingResourceSnapshot = {
      remoteId: randomUUID(),
      kind: 'vm',
      name: 'test',
      location: 'pve',
      powerState: 'running',
      cpu: 1,
      memoryMb: 1024,
      diskGb: 8,
      incarnation: randomUUID(),
      addresses: [],
      capabilities: hostingCapabilities({}),
      observedAt: new Date().toISOString(),
      ...patch,
    };
    const [row] = await db
      .insert(schema.hostingResources)
      .values({
        connectorId: connector.id,
        provider: connector.provider as 'proxmox',
        authority: (connector.settings as StoredHostingSettings).authority,
        remoteId: snapshot.remoteId,
        kind: snapshot.kind,
        origin: 'discovered',
        incarnation: snapshot.incarnation,
        snapshot,
        observedAt: new Date(snapshot.observedAt),
      })
      .returning();
    return row;
  }

  it('hides unrelated provider inventory while exposing created and bound resources', async () => {
    const row = await account('proxmox');
    const unrelated = await insertResource(row);
    const created = await insertResource(row);
    await db
      .update(schema.hostingResources)
      .set({ origin: 'created' })
      .where(eq(schema.hostingResources.id, created.id));
    const service = new HostingInventoryService(db, connectors(), {} as never, {} as never, audit as never);
    const visible = await service.resources(row.id, { ...owner, scopes: [...owner.scopes, 'hosting:resources:view'] });
    expect(visible.map((item) => item.id)).toEqual([created.id]);
    expect(visible.some((item) => item.id === unrelated.id)).toBe(false);
    expect(await service.resources(row.id, { ...owner, scopes: ['integrations:hosting:view'] })).toEqual([]);
  });

  it.each([
    false,
    true,
  ])('preserves nodes and bindings across connector reconnect (previously missing=%s)', async (wasMissing) => {
    const identity = randomUUID();
    const nodeId = randomUUID();
    const remoteId = '1130';
    // Both parameterized accounts remain in this DB; their interface evidence must be distinct.
    const ip = wasMissing ? '10.42.1.31' : '10.42.1.30';
    const mac = wasMissing ? 'aa:bb:cc:dd:ee:31' : 'aa:bb:cc:dd:ee:30';
    const authority = `test-reconnect-${randomUUID()}`;
    await db.insert(schema.nodes).values({
      id: nodeId,
      hostname: 'already-enrolled',
      slug: `reconnect-${nodeId}`,
      hostIdentityId: identity,
      lastSeenAt: new Date(),
      lastHealthReport: { networkInterfaces: [{ name: 'eth0', ipAddresses: [`${ip}/24`] }] } as never,
    });
    const snapshot: HostingResourceSnapshot = {
      remoteId,
      kind: 'ct',
      name: 'existing-ct',
      location: 'sora',
      powerState: 'running',
      cpu: 2,
      memoryMb: 1024,
      diskGb: 10,
      incarnation: 'stable-ct',
      addresses: [{ ip, mac, direct: true }],
      capabilities: hostingCapabilities({}),
      observedAt: new Date().toISOString(),
    };
    const adapter = {
      provider: 'proxmox',
      test: async () => ({ authority, name: 'Sora', capabilities: hostingCapabilities({ create: true }) }),
      listResources: async () => ({
        resources: [{ ...snapshot, observedAt: new Date().toISOString() }],
        complete: true,
        observedAt: new Date().toISOString(),
      }),
      guestIdentity: async () => null,
      catalog: async () => ({ locations: [], sizes: [], images: [] }),
    } as unknown as HostingProviderAdapter;
    const service = connectors(adapter);
    const entries = new Map<string, unknown>();
    const store = new ResourceSnapshotStore({
      get: async (key: string) => entries.get(key) ?? null,
      set: async (key: string, value: unknown) => {
        entries.set(key, value);
      },
      getClient: () => ({
        set: async () => {
          throw new Error('lease transport unavailable');
        },
        del: async (...keys: string[]) => {
          for (const key of keys) entries.delete(key);
        },
      }),
    } as never);
    const inventory = new HostingInventoryService(
      db,
      service,
      { readFile: async () => Buffer.from(mac) } as never,
      { isNodeConnected: (id: string) => id === nodeId } as never,
      audit as never,
      store
    );
    service.setInventoryLifecycle(
      (id) => inventory.initialize(id),
      (id) => inventory.refreshSnapshot(id)
    );
    const actor = { ...owner, scopes: [...owner.scopes, 'hosting:resources:view'] };
    const input = {
      provider: 'proxmox' as const,
      name: `reconnect-${identity}`,
      baseUrl: 'https://pve.test:8006',
      token: 'test-secret-not-for-snapshot',
      enabled: true,
      settings: HostingSettingsSchema.parse({
        adoptionEnabled: true,
        adoptionNodeIds: [nodeId],
        proxmoxHost: 'sora',
        // Reconnect is tested inside the explicitly selected provider resource scope.
        resourceIds: [remoteId],
      }),
    };
    const firstConnection = await service.create(input, actor);
    expect(firstConnection.syncStatus).toBe('success');
    const visible = await inventory.resources(firstConnection.id, actor);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ remoteId, origin: 'adopted', nodes: [{ id: nodeId }] });
    const cache = await store.get<{ resources: Array<{ id: string }> }>('hosting-resources', firstConnection.id);
    expect(cache?.refreshStatus).toBe('success');
    expect(cache?.data.resources[0].id).toBe(visible[0].id);
    expect(JSON.stringify(cache)).not.toContain(input.token);
    if (wasMissing)
      await db
        .update(schema.hostingResources)
        .set({ missingSince: new Date() })
        .where(eq(schema.hostingResources.id, visible[0].id));
    await service.remove(firstConnection.id, actor);
    expect(await store.get('hosting-resources', firstConnection.id)).toBeNull();
    expect(await db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId))).toHaveLength(1);
    expect(
      await db.select().from(schema.hostingNodeBindings).where(eq(schema.hostingNodeBindings.nodeId, nodeId))
    ).toHaveLength(1);
    const detached = (
      await db.select().from(schema.hostingResources).where(eq(schema.hostingResources.id, visible[0].id))
    )[0];
    expect(detached.connectorId).toBeNull();
    const secondConnection = await service.create(input, actor);
    expect((await inventory.resources(secondConnection.id, actor))[0]).toMatchObject({
      id: visible[0].id,
      nodes: [{ id: nodeId }],
    });
  });

  it('rejects duplicate Hetzner credentials even when the project has no VMs', async () => {
    const authority = `hetzner-test-${randomUUID()}`;
    const service = connectors({
      test: async () => ({ authority, name: 'Hetzner', capabilities: hostingCapabilities({}) }),
    });
    const input = {
      provider: 'hetzner' as const,
      name: `empty-project-${randomUUID()}`,
      baseUrl: 'https://api.hetzner.cloud',
      token: 'same-project-token',
      enabled: true,
      settings: HostingSettingsSchema.parse({ adoptionEnabled: false }),
    };
    await service.create(input, owner);
    await expect(service.create(input, owner)).rejects.toMatchObject({ code: 'HOSTING_ACCOUNT_ALREADY_CONNECTED' });
    await expect(
      service.create({ ...input, name: `${input.name}-other`, token: 'another-project-token' }, owner)
    ).resolves.toHaveProperty('id');
  });

  it('does not report successful creation or leave a duplicate when initial inventory fails', async () => {
    const service = connectors({
      test: async () => ({ authority: randomUUID(), name: 'test', capabilities: hostingCapabilities({}) }),
    });
    service.setInventoryLifecycle(
      async () => {
        throw new Error('Provider inventory unavailable');
      },
      async () => {}
    );
    const name = `failed-connect-${randomUUID()}`;
    await expect(
      service.create(
        {
          provider: 'hostkey',
          name,
          baseUrl: 'https://invapi.hostkey.com',
          enabled: true,
          token: 'test',
          settings: HostingSettingsSchema.parse({ adoptionEnabled: false }),
        },
        { ...owner, scopes: [...owner.scopes, 'hosting:resources:view'] }
      )
    ).rejects.toThrow('Provider inventory unavailable');
    expect(
      await db.select().from(schema.integrationConnectors).where(eq(schema.integrationConnectors.name, name))
    ).toEqual([]);
  });

  it('rejects changed Hetzner tokens before provider reads or connector writes', async () => {
    const row = await account('hetzner');
    const test = vi.fn();
    await expect(
      connectors({ test }).update(
        row.id,
        {
          provider: 'hetzner',
          name: row.name,
          baseUrl: 'https://api.hetzner.cloud',
          enabled: true,
          token: 'another-project-token',
          settings: HostingSettingsSchema.parse({ adoptionEnabled: false }),
        },
        owner
      )
    ).rejects.toMatchObject({ code: 'HOSTING_PROJECT_IDENTITY_UNVERIFIABLE' });
    expect(test).not.toHaveBeenCalled();
    const [retained] = await db
      .select()
      .from(schema.integrationConnectors)
      .where(eq(schema.integrationConnectors.id, row.id));
    expect(retained.encryptedToken).toBe(row.encryptedToken);
  });

  it('rejects a legacy Proxmox update when trusted old and proposed connections discover different clusters', async () => {
    const row = await account('proxmox', {
      authority: 'proxmox:legacy-name',
      clusterId: 'legacy-name',
      tokenId: 'gateway@pve!hosting',
      proxmoxHost: 'pve-a',
    });
    const service = new HostingConnectorsService(
      db,
      crypto as never,
      audit as never,
      events as never,
      auth,
      (connection) =>
        ({
          test: async () => ({
            authority: connection.baseUrl === row.baseUrl ? 'proxmox:ca:old' : 'proxmox:ca:different',
            name: 'PVE',
            capabilities: hostingCapabilities({}),
          }),
        }) as HostingProviderAdapter
    );
    await expect(
      service.update(
        row.id,
        {
          provider: 'proxmox',
          name: row.name,
          baseUrl: 'https://replacement.test:8006',
          enabled: true,
          token: 'replacement-token',
          settings: HostingSettingsSchema.parse({ tokenId: 'gateway@pve!hosting', proxmoxHost: 'pve-a' }),
        },
        owner
      )
    ).rejects.toMatchObject({ code: 'HOSTING_ACCOUNT_CHANGED' });
    const [unchanged] = await db
      .select()
      .from(schema.integrationConnectors)
      .where(eq(schema.integrationConnectors.id, row.id));
    expect(unchanged.baseUrl).toBe(row.baseUrl);
    expect((unchanged.settings as StoredHostingSettings).authority).toBe('proxmox:legacy-name');
    await db.delete(schema.integrationConnectors).where(eq(schema.integrationConnectors.id, row.id));
  });

  it('reconciles legacy Proxmox allocation identity for sync, physical-host uniqueness, and shared pool admission', async () => {
    const canonical = `proxmox:ca:${'a'.repeat(64)}`;
    const legacy = await account('proxmox', {
      authority: 'proxmox:legacy-name',
      clusterId: 'legacy-name',
      tokenId: 'gateway@pve!hosting',
      proxmoxHost: 'pve-a',
    });
    const adapter = {
      test: async () => ({ authority: canonical, name: 'PVE', capabilities: hostingCapabilities({}) }),
      listResources: async () => ({ resources: [], complete: true, observedAt: new Date().toISOString() }),
    } as unknown as HostingProviderAdapter;
    const connectorService = connectors(adapter);
    const candidate = {
      provider: 'proxmox' as const,
      name: 'PVE',
      baseUrl: 'https://pve.test:8006',
      token: 'new-token',
      enabled: true,
      settings: HostingSettingsSchema.parse({ tokenId: 'gateway@pve!hosting', proxmoxHost: 'pve-a' }),
    };
    await expect(connectorService.create(candidate, owner)).rejects.toMatchObject({
      code: 'HOSTING_LEGACY_RECONCILIATION_REQUIRED',
    });
    await connectorService.test(legacy.id, owner);
    await new HostingInventoryService(db, connectorService, {} as never, {} as never, audit as never).sync(
      legacy.id,
      owner
    );
    const [reconciled] = await db
      .select()
      .from(schema.integrationConnectors)
      .where(eq(schema.integrationConnectors.id, legacy.id));
    expect(reconciled.settings as StoredHostingSettings).toMatchObject({
      authority: 'proxmox:legacy-name',
      proxmoxAllocationAuthority: canonical,
    });
    await expect(
      connectors({
        ...adapter,
        test: async () => ({
          authority: 'proxmox:ca:different',
          name: 'Different',
          capabilities: hostingCapabilities({}),
        }),
      }).test(legacy.id, owner)
    ).rejects.toMatchObject({ code: 'HOSTING_ACCOUNT_CHANGED' });
    const connector = {
      provider: 'proxmox' as const,
      name: 'PVE',
      baseUrl: 'https://pve.test:8006',
      token: 'new-token',
      enabled: true,
      settings: HostingSettingsSchema.parse({ tokenId: 'gateway@pve!hosting', proxmoxHost: 'pve-a' }),
    };
    await expect(connectorService.create(connector, owner)).rejects.toMatchObject({
      code: 'HOSTING_ACCOUNT_ALREADY_CONNECTED',
    });
    const separate = await connectorService.create(
      { ...connector, name: 'PVE second host', settings: { ...connector.settings, proxmoxHost: 'pve-b' } },
      owner
    );
    expect(separate.settings.proxmoxHost).toBe('pve-b');
    await first.reserve({
      connectorId: legacy.id,
      actorId,
      action: 'create',
      idempotencyKey: randomUUID(),
      request: { vmid: 250 },
    });
    const allocation = await db.transaction((tx) =>
      allocateProxmoxPool(tx, {
        allocationAuthority: canonical,
        profile: {
          nodes: ['pve-b'],
          templateId: 9000,
          templateNode: 'pve-b',
          storage: 'local-lvm',
          bridge: 'vmbr0',
          pool: 'gateway',
          cleanTemplate: true,
          vmidRange: '250-251',
          network: 'dhcp',
        },
        usedVmids: [],
      })
    );
    expect(allocation.vmid).toBe(251);
  });

  it('clears stale saved TLS trust during discovery when the caller selects system trust', async () => {
    const row = await account('proxmox', {
      tokenId: 'gateway@pve!hosting',
      caCertificate: 'old-private-ca',
      certificateFingerprint: 'a'.repeat(64),
    });
    let discoveredSettings: HostingConnection['settings'] | undefined;
    const service = new HostingConnectorsService(
      db,
      crypto as never,
      audit as never,
      events as never,
      auth,
      (connection) => {
        discoveredSettings = connection.settings;
        return {
          discover: async () => ({ hosts: [], templates: [], storages: [], bridges: [], usedVmids: [] }),
        } as unknown as HostingProviderAdapter;
      }
    );
    await service.discover(
      {
        connectorId: row.id,
        provider: 'proxmox',
        name: row.name,
        baseUrl: row.baseUrl,
        token: 'fresh-token-for-system-trust',
        enabled: true,
        tlsMode: 'system',
        settings: { tokenId: 'gateway@pve!hosting' },
      },
      owner
    );
    expect(discoveredSettings).not.toHaveProperty('caCertificate');
    expect(discoveredSettings).not.toHaveProperty('certificateFingerprint');
  });

  it('atomically admits only the purchased HOSTKEY ID into a non-empty allowlist', async () => {
    const row = await account('hostkey', { resourceIds: ['existing-id'] });
    const source = await insertResource(row, { remoteId: 'purchased-id' });
    const service = new HostingProvisioningService(
      db,
      connectors(),
      first,
      {} as never,
      crypto as never,
      auth,
      {} as never,
      audit,
      {} as never
    );
    const tracked = await (
      service as unknown as {
        trackResource: (
          operation: HostingOperationRow,
          connector: HostingConnectorRow,
          snapshot: HostingResourceSnapshot
        ) => Promise<typeof source>;
      }
    ).trackResource({ action: 'create' } as HostingOperationRow, row, source.snapshot);
    const [updated] = await db
      .select()
      .from(schema.integrationConnectors)
      .where(eq(schema.integrationConnectors.id, row.id));
    expect((updated.settings as StoredHostingSettings).resourceIds).toEqual(['existing-id', 'purchased-id']);
    expect(tracked.id).toBe(source.id);
    expect(tracked.origin).toBe('created');
  });

  it('does not release an IP merely because an earlier incarnation was deleted', async () => {
    const allocationAuthority = `test-static-${randomUUID()}`;
    const row = await account('proxmox', {
      proxmoxAllocationAuthority: allocationAuthority,
      proxmox: {
        nodes: ['pve'],
        templateId: 9000,
        templateNode: 'pve',
        storage: 'test',
        imageStorage: 'test-import',
        seedStorage: 'test-iso',
        bridge: 'test',
        pool: 'gateway',
        cleanTemplate: true,
        vmidRange: '250-260',
        network: 'static',
        subnet: '10.40.0.0/24',
        gateway: '10.40.0.1',
        ipRange: '10.40.0.10-10.40.0.30',
      },
    });
    const vm = await insertResource(row, { incarnation: 'original', addresses: [{ ip: '10.40.0.20', direct: true }] });
    const reservation = await first.reserve({
      connectorId: row.id,
      resourceId: vm.id,
      actorId,
      action: 'create',
      idempotencyKey: randomUUID(),
      request: { ipAddress: '10.40.0.20' },
    });
    await first.finish((await first.claim(reservation.operation.id))!, 'ready');
    const deletion = await first.reserve({
      connectorId: row.id,
      resourceId: vm.id,
      actorId,
      action: 'delete',
      idempotencyKey: randomUUID(),
      request: {},
    });
    await first.finish((await first.claim(deletion.operation.id))!, 'ready', {
      providerDeleted: true,
      deletedIncarnation: 'original',
    });
    const reachedInitializer = vi.fn(async () => {
      throw new Error('passed IP guards');
    });
    const service = new HostingProvisioningService(
      db,
      connectors({
        discover: async () => ({ hosts: [], templates: [], storages: [], bridges: [], usedVmids: [], usedIps: [] }),
        catalog: async () => ({
          locations: [{ id: 'pve', name: 'pve' }],
          sizes: [{ id: 'custom', name: 'custom' }],
          images: [
            {
              id: '9000',
              name: 'test',
              operatingSystem: { distribution: 'debian', version: '13' },
              architecture: 'x64',
            },
          ],
          capacity: [
            {
              id: 'pve',
              name: 'pve',
              online: true,
              memoryTotalMb: 16000,
              memoryUsedMb: 0,
              diskTotalGb: 1000,
              diskUsedGb: 0,
            },
          ],
        }),
      }),
      first,
      {
        getGatewayEnrollmentTargets: async () => ({ public: { gateway: 'gateway.test:8443' } }),
        create: reachedInitializer,
      } as never,
      crypto as never,
      auth,
      {} as never,
      audit,
      {} as never
    );
    const create = () =>
      service.create(
        {
          connectorId: row.id,
          idempotencyKey: randomUUID(),
          role: 'nginx',
          name: 'ip-test',
          location: 'pve',
          size: 'custom',
          image: '9000',
          ipAddress: '10.40.0.20',
        },
        owner
      );
    // Missing original + matching confirmed delete is the only released state.
    await db
      .update(schema.hostingResources)
      .set({ missingSince: new Date() })
      .where(eq(schema.hostingResources.id, vm.id));
    await expect(create()).rejects.toThrow('passed IP guards');
    reachedInitializer.mockClear();
    // The same ID reappears: the historical successful deletion is no longer sufficient.
    await db.update(schema.hostingResources).set({ missingSince: null }).where(eq(schema.hostingResources.id, vm.id));
    await expect(create()).rejects.toMatchObject({ code: 'HOSTING_IP_RESERVED' });
    // A replacement later disappears, but its deletion has not been confirmed.
    await db
      .update(schema.hostingResources)
      .set({
        missingSince: new Date(),
        snapshot: { ...vm.snapshot, incarnation: 'replacement' },
        incarnation: 'replacement',
      })
      .where(eq(schema.hostingResources.id, vm.id));
    await expect(create()).rejects.toMatchObject({ code: 'HOSTING_IP_RESERVED' });
    expect(reachedInitializer).not.toHaveBeenCalled();
  });

  it('serializes pool admission across connectors sharing a discovered cluster authority', async () => {
    const authority = `proxmox:ca:${randomUUID()}`;
    const firstConnector = await account('proxmox', { authority });
    const secondConnector = await account('proxmox', { authority });
    const profile = {
      nodes: ['pve-a'],
      templateId: 9000,
      templateNode: 'pve-a',
      storage: 'local-lvm',
      bridge: 'vmbr0',
      pool: 'gateway',
      cleanTemplate: true,
      vmidRange: '250-252',
      network: 'static' as const,
      subnet: '10.42.0.0/24',
      gateway: '10.42.0.1',
      ipRange: '10.42.0.10-10.42.0.12',
    };
    const firstAllocation = await db.transaction((tx) =>
      allocateProxmoxPool(tx, { allocationAuthority: authority, profile, usedVmids: [], usedIps: [] })
    );
    await first.reserve({
      connectorId: firstConnector.id,
      actorId,
      action: 'create',
      idempotencyKey: randomUUID(),
      request: { vmid: firstAllocation.vmid, ipAddress: firstAllocation.ipAddress },
    });
    const secondAllocation = await db.transaction((tx) =>
      allocateProxmoxPool(tx, { allocationAuthority: authority, profile, usedVmids: [], usedIps: [] })
    );
    expect(firstAllocation).toEqual({ vmid: 250, ipAddress: '10.42.0.10' });
    expect(secondAllocation).toEqual({ vmid: 251, ipAddress: '10.42.0.11' });
    expect(secondConnector.id).not.toBe(firstConnector.id);
  });

  it('reuses a VMID only after the old incarnation has a confirmed provider deletion', async () => {
    const authority = `proxmox:ca:${randomUUID()}`;
    const connector = await account('proxmox', { authority });
    const profile = {
      nodes: ['pve-a'],
      templateId: 9000,
      templateNode: 'pve-a',
      storage: 'local-lvm',
      bridge: 'vmbr0',
      pool: 'gateway',
      cleanTemplate: true,
      vmidRange: '250-251',
      network: 'dhcp' as const,
    };
    const [original] = await db
      .insert(schema.hostingResources)
      .values({
        connectorId: connector.id,
        provider: 'proxmox',
        authority,
        remoteId: '250',
        kind: 'vm',
        origin: 'created',
        incarnation: 'first-incarnation',
        snapshot: {
          remoteId: '250',
          kind: 'vm',
          name: 'old-vm',
          location: 'pve-a',
          powerState: 'stopped',
          cpu: 1,
          memoryMb: 1024,
          diskGb: 8,
          incarnation: 'first-incarnation',
          addresses: [],
          capabilities: hostingCapabilities({}),
          observedAt: new Date().toISOString(),
        },
        observedAt: new Date(),
      })
      .returning();
    const create = await first.reserve({
      connectorId: connector.id,
      resourceId: original.id,
      actorId,
      action: 'create',
      idempotencyKey: randomUUID(),
      request: { vmid: 250 },
    });
    await first.finish(await first.dispatch((await first.claim(create.operation.id))!, 'dispatching'), 'ready');
    await db
      .update(schema.hostingResources)
      .set({ missingSince: new Date() })
      .where(eq(schema.hostingResources.id, original.id));
    const blocked = await db.transaction((tx) =>
      allocateProxmoxPool(tx, { allocationAuthority: authority, profile, usedVmids: [] })
    );
    expect(blocked.vmid).toBe(251);
    const deletion = await first.reserve({
      connectorId: connector.id,
      resourceId: original.id,
      actorId,
      action: 'delete',
      idempotencyKey: randomUUID(),
      request: {},
    });
    await first.finish((await first.claim(deletion.operation.id))!, 'ready', {
      providerDeleted: true,
      deletedIncarnation: 'first-incarnation',
    });
    const reused = await db.transaction((tx) =>
      allocateProxmoxPool(tx, { allocationAuthority: authority, profile, usedVmids: [] })
    );
    expect(reused.vmid).toBe(250);
    const [newIncarnation] = await db
      .insert(schema.hostingResources)
      .values({
        connectorId: connector.id,
        provider: 'proxmox',
        authority,
        remoteId: '250',
        kind: 'vm',
        origin: 'created',
        incarnation: 'second-incarnation',
        snapshot: { ...original.snapshot, incarnation: 'second-incarnation' },
        observedAt: new Date(),
      })
      .returning();
    expect(newIncarnation.id).not.toBe(original.id);
  });

  it.each([
    'unchanged',
    'interfaces_changed',
    'competing_inventory',
    'expired_at_commit',
    'connector_disabled',
    'adoption_disabled',
    'connector_revision',
    'resource_scope',
    'owner_revoked',
  ] as const)('adoption commits only fresh unchanged evidence: %s', async (scenario) => {
    const nodeId = randomUUID();
    const row = await account('proxmox', { adoptionEnabled: true, adoptionNodeIds: [nodeId] });
    const vm = await insertResource(row, { addresses: [{ ip: '10.41.0.20', mac: 'AA:BB:CC:DD:EE:FF', direct: true }] });
    const identity = randomUUID();
    await db.insert(schema.nodes).values({
      id: nodeId,
      hostname: 'adoption-race',
      slug: `adoption-${nodeId}`,
      hostIdentityId: identity,
      lastSeenAt: new Date(),
      lastHealthReport: { networkInterfaces: [{ name: 'eth0', ipAddresses: ['10.41.0.20/24'] }] } as never,
    });
    const adapter = {
      guestIdentity: async () => {
        if (scenario === 'interfaces_changed')
          await db
            .update(schema.nodes)
            .set({ lastHealthReport: { networkInterfaces: [] } as never })
            .where(eq(schema.nodes.id, nodeId));
        if (scenario === 'competing_inventory') await insertResource(row, { addresses: vm.snapshot.addresses });
        if (scenario === 'connector_disabled')
          await db
            .update(schema.integrationConnectors)
            .set({ enabled: false })
            .where(eq(schema.integrationConnectors.id, row.id));
        if (scenario === 'adoption_disabled' || scenario === 'resource_scope')
          await db
            .update(schema.integrationConnectors)
            .set({
              settings: {
                ...row.settings,
                ...(scenario === 'adoption_disabled' ? { adoptionEnabled: false } : { resourceIds: ['another-vm'] }),
              },
            })
            .where(eq(schema.integrationConnectors.id, row.id));
        if (scenario === 'connector_revision')
          await db
            .update(schema.integrationConnectors)
            .set({ updatedAt: new Date(row.updatedAt.getTime() + 1000) })
            .where(eq(schema.integrationConnectors.id, row.id));
        if (scenario === 'owner_revoked') auth.getUserById.mockResolvedValueOnce({ ...owner, scopes: [] });
        return null;
      },
    } as unknown as HostingProviderAdapter;
    const originalNow = Date.now();
    const proxied = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'transaction' && scenario === 'expired_at_commit')
          return (callback: Parameters<DrizzleClient['transaction']>[0]) =>
            target.transaction(async (tx) => {
              vi.spyOn(Date, 'now').mockReturnValue(originalNow + 600000);
              try {
                return await callback(tx);
              } finally {
                vi.mocked(Date.now).mockRestore();
              }
            });
        return Reflect.get(target, property, receiver);
      },
    });
    const inventory = new HostingInventoryService(
      proxied,
      connectors(adapter),
      { readFile: async () => Buffer.from('aa:bb:cc:dd:ee:ff') } as never,
      { isNodeConnected: () => true } as never,
      audit as never
    );
    const adoption = (
      inventory as unknown as {
        adopt: (connector: HostingConnectorRow, adapter: HostingProviderAdapter) => Promise<void>;
      }
    ).adopt(row, adapter);
    if (scenario === 'owner_revoked') await expect(adoption).rejects.toMatchObject({ statusCode: 403 });
    else await adoption;
    const bindings = await db
      .select()
      .from(schema.hostingNodeBindings)
      .where(eq(schema.hostingNodeBindings.nodeId, nodeId));
    expect(bindings).toHaveLength(scenario === 'unchanged' ? 1 : 0);
    // Keep subsequent cases independent while preserving the evidence fixture for inspection.
    await db
      .update(schema.hostingResources)
      .set({ missingSince: new Date() })
      .where(eq(schema.hostingResources.connectorId, row.id));
  });
});
