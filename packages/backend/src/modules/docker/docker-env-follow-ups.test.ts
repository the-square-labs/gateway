import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recreateWithConfig, updateContainer, updateContainerEnv } from './docker-container-mutation-operations.js';
import {
  DAEMON_ERROR,
  fakeDockerNode,
  gatewayProcess,
  memoryEnvironmentStore,
  memoryTaskStore,
} from './docker-env-follow-ups.test-helpers.js';
import { DockerTaskReconciler } from './docker-task-reconciler.js';

const NODE = '00000000-0000-4000-8000-0000000000a1';
const SECRET = 's3cret-value';
const NEW_SECRET = 'n3w-secret-value';
/** APP_MODE only mirrors the old image's default; API_KEY is set by the user. */
const STORED = { APP_MODE: 'mode-one', API_KEY: SECRET };
const OLD_ENV = ['APP_MODE=mode-one', `API_KEY=${SECRET}`, 'PATH=/usr/bin'];
const NEW_IMAGE_ENV = ['APP_MODE=mode-two', `API_KEY=${SECRET}`, 'PATH=/usr/bin'];

function setup(options: { syncAnswer?: boolean } = {}) {
  const node = fakeDockerNode(OLD_ENV, NEW_IMAGE_ENV, options);
  const tasks = memoryTaskStore();
  const environment = memoryEnvironmentStore({ api: STORED });
  const first = gatewayProcess(node, tasks.service, environment.service, NODE);
  return {
    node,
    tasks,
    environment,
    first,
    /** Gateway restarts: the operation's watch is gone, and the next process detaches what the node may still run. */
    restart() {
      vi.clearAllTimers();
      tasks.restart();
      const next = gatewayProcess(node, tasks.service, environment.service, NODE);
      return {
        ...next,
        reconciler: new DockerTaskReconciler(
          () => next.reconcileContext,
          () => true
        ),
      };
    },
    task(id: string | undefined) {
      const row = tasks.rows.get(String(id));
      if (!row) throw new Error(`no task ${id}`);
      return row;
    },
  };
}

/** Lets the operation record its task's tracking (and what it keeps for later) before the restart. */
const settleWrites = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('env follow-ups of an update or recreate Gateway restarted during', () => {
  it('reconciles the stored env after an image update once the node finished it', async () => {
    const t = setup();
    const result = await updateContainer(t.first.ctx, NODE, 'api', { tag: '2' }, 'user-1');
    await settleWrites();

    const next = t.restart();
    // What the task keeps for later shows no env name or value.
    const kept = JSON.stringify(t.task(result.taskId).followUps);
    expect(t.task(result.taskId).followUps).toMatchObject({ containerName: 'api', reconcileEnvAfterImageChange: true });
    for (const plain of [SECRET, 'API_KEY', 'APP_MODE', 'mode-one']) expect(kept).not.toContain(plain);

    await next.reconciler.sweep();
    expect(t.task(result.taskId).status).toBe('running');
    expect(t.environment.stored.get('api')).toEqual(STORED);

    t.node.finish('succeeded');
    await next.reconciler.sweep();
    expect(t.task(result.taskId)).toMatchObject({ status: 'succeeded', followUps: null });
    // The stored APP_MODE only mirrored the old image's default: it follows the new image; the user's API_KEY stays.
    expect(t.environment.stored.get('api')).toEqual({ APP_MODE: 'mode-two', API_KEY: SECRET });
  });

  it.each([
    [
      'a recreate with another image',
      {},
      (ctx: Parameters<typeof recreateWithConfig>[0]) =>
        recreateWithConfig(ctx, NODE, 'api', { image: 'registry.local/app:2' }, 'user-1', { skipImagePull: true }),
    ],
    [
      'a recreate whose image Gateway pulls in the background first',
      {},
      (ctx: Parameters<typeof recreateWithConfig>[0]) =>
        recreateWithConfig(ctx, NODE, 'api', { image: 'registry.local/app:2' }, 'user-1', {
          backgroundImagePull: true,
        }),
    ],
    [
      'an image update a daemon before 2.10 answered once done',
      { syncAnswer: true },
      (ctx: Parameters<typeof recreateWithConfig>[0]) => updateContainer(ctx, NODE, 'api', { tag: '2' }, 'user-1'),
    ],
  ])('reconciles the stored env after %s once the node finished it', async (_case, options, run) => {
    const t = setup(options);
    const result = await run(t.first.ctx);
    await vi.waitFor(() => expect(t.task(result.taskId).tracking).not.toBeNull());

    const next = t.restart();
    expect(t.task(result.taskId).followUps).toMatchObject({ reconcileEnvAfterImageChange: true });
    t.node.finish('succeeded');
    await next.reconciler.sweep();
    expect(t.task(result.taskId)).toMatchObject({ status: 'succeeded', followUps: null });
    expect(t.environment.stored.get('api')).toEqual({ APP_MODE: 'mode-two', API_KEY: SECRET });
  });

  it.each([
    [
      'an update with an env change',
      (ctx: Parameters<typeof updateContainer>[0]) =>
        updateContainer(ctx, NODE, 'api', { env: { API_KEY: NEW_SECRET } }, 'user-1'),
    ],
    [
      'an env change',
      (ctx: Parameters<typeof updateContainer>[0]) =>
        updateContainerEnv(ctx, NODE, 'api', { API_KEY: NEW_SECRET }, undefined, 'user-1'),
    ],
  ])('restores the stored env after %s the node failed', async (_case, run) => {
    const t = setup();
    const result = await run(t.first.ctx);
    await settleWrites();
    // Saved with the operation, before the node ran it.
    expect(t.environment.stored.get('api')).toEqual({ APP_MODE: 'mode-one', API_KEY: NEW_SECRET });

    const next = t.restart();
    const kept = JSON.stringify(t.task(result.taskId).followUps);
    expect(t.task(result.taskId).followUps).toMatchObject({ restoreEnvAfterFailedUpdate: true });
    for (const plain of [SECRET, NEW_SECRET, 'API_KEY', 'APP_MODE', 'mode-one']) expect(kept).not.toContain(plain);

    t.node.finish('failed');
    await next.reconciler.sweep();
    expect(t.task(result.taskId)).toMatchObject({ status: 'failed', error: DAEMON_ERROR, followUps: null });
    expect(t.environment.stored.get('api')).toEqual(STORED);
  });
});

describe('env follow-ups run once', () => {
  it('leaves nothing to the next process once the watch ran the reconciliation', async () => {
    const t = setup();
    const result = await updateContainer(t.first.ctx, NODE, 'api', { tag: '2' }, 'user-1');
    t.node.finish('succeeded');
    // The watch reconciles, and the process stops before it marks the task succeeded.
    t.tasks.failNextEnd();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.environment.writes).toHaveLength(1);
    expect(t.task(result.taskId).status).toBe('running');

    // A user then sets APP_MODE back, which a second reconciliation would undo.
    t.environment.stored.set('api', { APP_MODE: 'mode-one', API_KEY: SECRET });
    const next = t.restart();
    await next.reconciler.sweep();
    expect(t.task(result.taskId)).toMatchObject({ status: 'succeeded', followUps: null });
    expect(t.environment.writes).toHaveLength(1);
    expect(t.environment.stored.get('api')).toEqual({ APP_MODE: 'mode-one', API_KEY: SECRET });
  });

  it('leaves nothing to the next process once the watch restored the env', async () => {
    const t = setup();
    const result = await updateContainerEnv(t.first.ctx, NODE, 'api', { API_KEY: NEW_SECRET }, undefined, 'user-1');
    t.node.finish('failed');
    t.tasks.failNextEnd();
    await vi.advanceTimersByTimeAsync(2_000);
    // The env saved before dispatch, then the restore.
    expect(t.environment.writes).toHaveLength(2);
    expect(t.environment.stored.get('api')).toEqual(STORED);
    expect(t.task(result.taskId).status).toBe('running');

    const next = t.restart();
    await next.reconciler.sweep();
    expect(t.task(result.taskId)).toMatchObject({ status: 'failed', followUps: null });
    expect(t.environment.writes).toHaveLength(2);
  });

  it('does not run it again when its task could not be settled at once', async () => {
    const t = setup();
    const result = await updateContainer(t.first.ctx, NODE, 'api', { tag: '2' }, 'user-1');
    await settleWrites();
    const next = t.restart();
    t.node.finish('succeeded');

    t.tasks.failNextEnd();
    await next.reconciler.sweep();
    expect(t.environment.writes).toHaveLength(1);
    expect(t.task(result.taskId).status).toBe('running');

    t.environment.stored.set('api', { APP_MODE: 'mode-one', API_KEY: SECRET });
    await next.reconciler.sweep();
    expect(t.task(result.taskId)).toMatchObject({ status: 'succeeded', followUps: null });
    expect(t.environment.writes).toHaveLength(1);
  });

  it('waits while another operation holds the container, and drops it once a later operation changed the env', async () => {
    const t = setup();
    const result = await updateContainerEnv(t.first.ctx, NODE, 'api', { API_KEY: NEW_SECRET }, undefined, 'user-1');
    await settleWrites();
    const next = t.restart();
    t.node.finish('failed');

    const held = next.transitions.claim(NODE, [{ name: 'api', state: 'updating' }]);
    await next.reconciler.sweep();
    expect(t.task(result.taskId).status).toBe('running');
    expect(t.task(result.taskId).followUps).not.toBeNull();

    // That operation saved another env meanwhile: putting back the old one would undo it.
    t.environment.stored.set('api', { APP_MODE: 'mode-three', API_KEY: NEW_SECRET });
    next.transitions.release(held);
    await next.reconciler.sweep();
    expect(t.task(result.taskId)).toMatchObject({ status: 'failed', error: DAEMON_ERROR, followUps: null });
    expect(t.environment.stored.get('api')).toEqual({ APP_MODE: 'mode-three', API_KEY: NEW_SECRET });
  });

  it('keeps nothing for an image update whose stored env has no entry the new image could change', async () => {
    const t = setup();
    t.environment.stored.set('api', {});
    const result = await updateContainer(t.first.ctx, NODE, 'api', { tag: '2' }, 'user-1');
    await settleWrites();
    expect(t.task(result.taskId).followUps).toBeNull();
  });
});
