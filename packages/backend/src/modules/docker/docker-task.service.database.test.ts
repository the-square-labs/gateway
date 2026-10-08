import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { listNodeLongTasks } from '@/services/node-long-tasks.js';
import { DETACHED_TASK_PROGRESS, DockerTaskService } from './docker-task.service.js';

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;

/**
 * Opt-in (GATEWAY_MIGRATION_TEST_DATABASE_URL): a Gateway restart keeps the Docker tasks a node may still run
 * (they have tracking) active, so a daemon update waiting for the node's tasks still sees them, and settles them
 * later; a task without tracking fails as before (F-1).
 */
describe.skipIf(!url)('Docker tasks across a Gateway restart', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let nodeId = '';

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'docker_task_tracking');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema }) as unknown as DrizzleClient;
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    const suffix = randomUUID().slice(0, 8);
    nodeId = (await pool.query(`insert into nodes (hostname, slug) values ($1, $1) returning id`, [`node-${suffix}`]))
      .rows[0].id;
  });

  it('keeps a tracked pull for the update wait and fails an untracked task', async () => {
    const service = new DockerTaskService(db);
    const pull = await service.create({ nodeId, containerName: 'pytorch/pytorch:2.5.1', type: 'pull' });
    await service.update(pull.id, { status: 'running' });
    await service.track(
      pull.id,
      { kind: 'pull', imageRef: 'pytorch/pytorch:2.5.1', deadlineAt: new Date(Date.now() + 600_000).toISOString() },
      'cmd-1'
    );
    const untracked = await service.create({ nodeId, containerName: 'app', type: 'start' });
    await service.update(untracked.id, { status: 'running' });

    // The next Gateway process starts.
    const restarted = new DockerTaskService(db);
    expect(await restarted.detachActiveTasksOnStartup()).toEqual({ detached: 1, failed: 1 });

    const kept = await restarted.get(pull.id);
    expect(kept).toMatchObject({ status: 'running', progress: DETACHED_TASK_PROGRESS });
    expect(kept.detachedAt).toBeInstanceOf(Date);
    // The API does not show what Gateway keeps to settle the task.
    expect(kept).not.toHaveProperty('tracking');
    expect(kept).not.toHaveProperty('commandId');
    expect(await restarted.get(untracked.id)).toMatchObject({
      status: 'failed',
      error: 'Task tracking interrupted by backend restart',
    });

    // A daemon update dispatched now waits for the pull.
    expect(await listNodeLongTasks(db, nodeId)).toEqual([
      { kind: 'docker_task', id: pull.id, label: 'Image pull pytorch/pytorch:2.5.1' },
    ]);

    const detached = await restarted.listDetached(nodeId);
    expect(detached.map((task) => [task.id, task.commandId, task.tracking?.kind])).toEqual([
      [pull.id, 'cmd-1', 'pull'],
    ]);

    expect(await restarted.settle(pull.id, { status: 'succeeded', progress: 'Pulled pytorch/pytorch:2.5.1' })).toBe(
      true
    );
    expect(await restarted.get(pull.id)).toMatchObject({ status: 'succeeded', detachedAt: null });
    // Settled once: a second outcome does not overwrite it.
    expect(await restarted.settle(pull.id, { status: 'failed', error: 'late' })).toBe(false);
    expect(await listNodeLongTasks(db, nodeId)).toEqual([]);
    expect(await restarted.listDetached(nodeId)).toEqual([]);
  });

  it('detaches a tracked task whose node dropped, and fails one without tracking', async () => {
    const service = new DockerTaskService(db);
    const stop = await service.create({ nodeId, containerName: 'app', type: 'stop' });
    await service.update(stop.id, { status: 'running' });
    await service.track(stop.id, {
      kind: 'state',
      containerId: 'c1',
      expect: 'exited',
      progress: 'Container stopped',
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await service.detach(stop.id, 'Docker node disconnected during container operation')).toBe(true);
    expect(await service.get(stop.id)).toMatchObject({ status: 'running' });

    const other = await service.create({ nodeId, containerName: 'app', type: 'kill' });
    await service.update(other.id, { status: 'running' });
    expect(await service.detach(other.id, 'Docker node disconnected during container operation')).toBe(false);
    expect(await service.get(other.id)).toMatchObject({
      status: 'failed',
      error: 'Docker node disconnected during container operation',
    });

    // A second restart keeps the time Gateway first lost track of it.
    const firstDetachedAt = (await service.get(stop.id)).detachedAt;
    await new DockerTaskService(db).detachActiveTasksOnStartup();
    expect((await service.get(stop.id)).detachedAt).toEqual(firstDetachedAt);
  });
});
