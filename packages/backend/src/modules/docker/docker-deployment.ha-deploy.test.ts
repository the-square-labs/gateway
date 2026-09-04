import { describe, expect, it, vi } from 'vitest';
import { dockerDeploymentReleases, dockerDeployments, dockerSourceBindings } from '@/db/schema/index.js';
import { DockerDeploymentService } from './docker-deployment.service.js';

function fixture(managed = true) {
  const deployment = {
    id: 'deployment',
    nodeId: 'origin',
    name: 'api',
    activeSlot: 'blue',
    status: 'ready',
    desiredConfig: { image: 'registry/api:v1', env: { KEEP: 'yes' }, runtimeProfile: 'secure', mounts: [] },
  };
  const updates: Array<{ table: unknown; patch: any }> = [];
  const db = {
    insert: () => ({ values: () => ({ returning: async () => [{ id: 'release' }] }) }),
    update: (table: unknown) => ({
      set: (patch: any) => ({
        where: async () => {
          updates.push({ table, patch });
          if (table === dockerDeployments) Object.assign(deployment, patch);
        },
      }),
    }),
  };
  const tasks = { create: vi.fn().mockResolvedValue({ id: 'task' }), update: vi.fn().mockResolvedValue(undefined) };
  const subject = new DockerDeploymentService(
    db as never,
    { log: vi.fn() } as never,
    {} as never,
    {} as never,
    tasks as never,
    {} as never
  ) as any;
  subject.loadDeployment = vi.fn(async () => ({ ...deployment }));
  subject.validateDockerNode = vi.fn();
  subject.assertRuntimeProfile = vi.fn();
  subject.switchToSlot = vi.fn();
  subject.imageCleanupService = { scheduleCleanupForDeployment: vi.fn().mockResolvedValue(undefined) };
  const coordinator = {
    isManaged: vi.fn().mockResolvedValue(managed),
    deploy: vi.fn().mockResolvedValue({
      desiredConfig: { ...deployment.desiredConfig, image: 'registry/api:v2' },
      shouldRun: true,
      activeSlot: 'green',
    }),
    updateConfiguration: vi.fn(),
    setRunning: vi.fn(),
    switchSlot: vi.fn(),
  };
  subject.setAvailabilityCoordinator(coordinator);
  return { subject, coordinator, tasks, deployment, updates };
}

describe('HA deployment webhook/Git common entry', () => {
  it('rolls back HA through the coordinator with the previous full configuration, not the old origin node', async () => {
    const { subject, coordinator, deployment, updates } = fixture();
    const previous = {
      image: 'registry/api:previous',
      env: { OLD: 'yes' },
      runtimeProfile: 'secure',
      command: ['old'],
      mounts: [],
    };
    Object.assign(deployment, { slots: [{ slot: 'green', image: previous.image, desiredConfig: previous }] });
    await subject.rollback('origin', 'deployment', false, 'user');
    expect(coordinator.deploy).toHaveBeenCalledWith(
      'deployment',
      {
        image: previous.image,
        env: previous.env,
        desiredConfig: previous,
      },
      'green',
      'user',
      'rollback',
      'release'
    );
    expect(subject.switchToSlot).not.toHaveBeenCalled();
    expect(subject.validateDockerNode).not.toHaveBeenCalled();
    expect(updates).toContainEqual({
      table: dockerSourceBindings,
      patch: expect.objectContaining({ deployedCommitSha: null }),
    });
  });

  it('does not fall back to physical rollback when HA fails', async () => {
    const { subject, coordinator, deployment, updates } = fixture();
    Object.assign(deployment, { slots: [{ slot: 'green', image: 'registry/api:previous' }] });
    coordinator.deploy.mockRejectedValue(new Error('HA rollback failed'));
    await expect(subject.rollback('origin', 'deployment', false, 'user')).rejects.toThrow('HA rollback failed');
    expect(subject.switchToSlot).not.toHaveBeenCalled();
    expect(updates.some((update) => update.table === dockerSourceBindings)).toBe(false);
  });

  it('preserves running Git provenance when a stopped rollback is deferred', async () => {
    const { subject, coordinator, deployment, updates } = fixture();
    Object.assign(deployment, { slots: [{ slot: 'green', image: 'registry/api:previous' }] });
    coordinator.deploy.mockResolvedValue({
      desiredConfig: deployment.desiredConfig,
      shouldRun: false,
      activeSlot: 'blue',
    });
    await subject.rollback('origin', 'deployment', false, 'user');
    expect(updates.some((update) => update.table === dockerSourceBindings)).toBe(false);
  });

  it('allows a valid retry after rollback preflight rejects a previous host mount', async () => {
    const { subject, coordinator, deployment } = fixture();
    const previous = {
      image: 'registry/api:previous',
      mounts: [{ hostPath: '/srv/legacy', containerPath: '/data', readOnly: false }],
    };
    Object.assign(deployment, { slots: [{ slot: 'green', image: previous.image, desiredConfig: previous }] });
    await expect(subject.rollback('origin', 'deployment', false, 'user')).rejects.toMatchObject({
      code: 'MISSING_DOCKER_MOUNTS_SCOPE',
    });
    expect(coordinator.deploy).not.toHaveBeenCalled();
    previous.mounts = [];
    await expect(subject.rollback('origin', 'deployment', false, 'user')).resolves.toBeDefined();
    expect(coordinator.deploy).toHaveBeenCalledOnce();
  });

  it('preserves ordinary physical rollback', async () => {
    const { subject, coordinator, deployment } = fixture(false);
    Object.assign(deployment, { slots: [{ slot: 'green', image: 'registry/api:previous' }] });
    await subject.rollback('origin', 'deployment', false, 'user');
    expect(subject.switchToSlot).toHaveBeenCalledWith(
      'origin',
      'deployment',
      { slot: 'green', force: false },
      'user',
      expect.objectContaining({ image: 'registry/api:previous', source: 'rollback' }),
      []
    );
    expect(coordinator.deploy).not.toHaveBeenCalled();
  });

  it.each([
    'webhook',
    'git',
  ])('%s waits for the HA rollout and never switches one physical deployment', async (source) => {
    const { subject, coordinator, tasks, updates } = fixture();
    let complete!: (value: any) => void;
    coordinator.deploy.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const operation = subject.deploy('origin', 'deployment', { tag: 'v2', env: { NEXT: 'yes' } }, 'user', source);
    await vi.waitFor(() => expect(coordinator.deploy).toHaveBeenCalled());
    expect(tasks.update).not.toHaveBeenCalledWith('task', expect.objectContaining({ status: 'succeeded' }));
    complete({
      desiredConfig: { image: 'registry/api:v2', runtimeProfile: 'secure', env: { NEXT: 'yes' } },
      shouldRun: true,
      activeSlot: 'green',
    });
    await operation;
    expect(coordinator.deploy).toHaveBeenCalledWith(
      'deployment',
      { tag: 'v2', env: { NEXT: 'yes' } },
      'green',
      'user',
      source,
      'release'
    );
    expect(subject.validateDockerNode).not.toHaveBeenCalled();
    expect(subject.assertRuntimeProfile).not.toHaveBeenCalled();
    expect(subject.switchToSlot).not.toHaveBeenCalled();
    expect(subject.imageCleanupService.scheduleCleanupForDeployment).not.toHaveBeenCalled();
    expect(updates).toContainEqual({
      table: dockerDeploymentReleases,
      patch: expect.objectContaining({ status: 'succeeded' }),
    });
  });

  it('propagates HA failure and fails the release/task instead of falling back to local deployment', async () => {
    const { subject, coordinator, tasks, updates } = fixture();
    coordinator.deploy.mockRejectedValue(new Error('HA rollout failed'));
    await expect(subject.deploy('origin', 'deployment', {}, 'user', 'webhook')).rejects.toThrow('HA rollout failed');
    expect(tasks.update).toHaveBeenCalledWith('task', expect.objectContaining({ status: 'failed' }));
    expect(updates).toContainEqual({
      table: dockerDeploymentReleases,
      patch: expect.objectContaining({ status: 'failed' }),
    });
    expect(subject.switchToSlot).not.toHaveBeenCalled();
  });

  it('reports stopped configuration as deferred, not a successfully activated release', async () => {
    const { subject, coordinator, updates, tasks } = fixture();
    coordinator.deploy.mockResolvedValue({
      desiredConfig: { image: 'registry/api:v2', runtimeProfile: 'secure', env: { KEEP: 'yes' }, mounts: [] },
      shouldRun: false,
      activeSlot: 'blue',
    });
    expect(await subject.deploy('origin', 'deployment', { tag: 'v2' }, 'user')).toMatchObject({
      status: 'stopped',
      deploymentDeferred: true,
    });
    expect(updates).toContainEqual({
      table: dockerDeploymentReleases,
      patch: expect.objectContaining({ status: 'pending', completedAt: null }),
    });
    expect(tasks.update).toHaveBeenCalledWith(
      'task',
      expect.objectContaining({ progress: 'Configuration saved; rollout deferred until Start' })
    );
  });

  it('keeps the ordinary single/non-HA deploy path and does not invoke the HA deploy coordinator', async () => {
    const { subject, coordinator } = fixture(false);
    await subject.deploy('origin', 'deployment', { tag: 'v2' }, 'user', 'git');
    expect(subject.validateDockerNode).toHaveBeenCalledWith('origin');
    expect(subject.assertRuntimeProfile).toHaveBeenCalled();
    expect(subject.switchToSlot).toHaveBeenCalledWith(
      'origin',
      'deployment',
      { slot: 'green', force: false },
      'user',
      expect.objectContaining({ image: 'registry/api:v2', source: 'git', releaseId: 'release' })
    );
    expect(coordinator.deploy).not.toHaveBeenCalled();
  });
});
