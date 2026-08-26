import { describe, expect, it, vi } from 'vitest';
import {
  isComposeOwnedContainer,
  isComposeOwnedNetwork,
  isComposeOwnedVolume,
  observeComposeProjects,
  planExternalComposeProjectReconciliation,
  reconcileExternalComposeProjects,
} from './compose-discovery.service.js';

describe('Compose discovery', () => {
  it('aggregates canonical labels deterministically without reading working-directory or config-file labels', () => {
    const first = observeComposeProjects({
      containers: [
        {
          Name: '/api-1',
          Labels: {
            'com.docker.compose.project': 'demo',
            'com.docker.compose.service': 'api',
            'com.docker.compose.container-number': '1',
            'com.docker.compose.project.working_dir': '/private/host/path',
            'com.docker.compose.project.config_files': '/private/host/compose.yml',
          },
        },
      ],
      volumes: [
        {
          Name: 'demo-data',
          Labels: { 'com.docker.compose.project': 'demo', 'com.docker.compose.volume': 'data' },
        },
      ],
    });
    const second = observeComposeProjects({
      volumes: [
        {
          Name: 'demo-data',
          Labels: { 'com.docker.compose.volume': 'data', 'com.docker.compose.project': 'demo' },
        },
      ],
      containers: [
        {
          Name: '/api-1',
          Labels: {
            'com.docker.compose.service': 'api',
            'com.docker.compose.project': 'demo',
            'com.docker.compose.container-number': '1',
            'com.docker.compose.project.working_dir': '/different/path',
          },
        },
      ],
    });

    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ name: 'demo' });
  });

  it('keeps external/shared volumes and networks standalone while classifying project-owned resources', () => {
    const external = { Labels: { external: 'true' } };
    const projectVolume = {
      Labels: { 'com.docker.compose.project': 'demo', 'com.docker.compose.volume': 'data' },
    };
    const projectNetwork = {
      Labels: { 'com.docker.compose.project': 'demo', 'com.docker.compose.network': 'default' },
    };

    expect(isComposeOwnedContainer({ Labels: { 'com.docker.compose.project': 'demo' } })).toBe(true);
    expect(isComposeOwnedVolume(projectVolume)).toBe(true);
    expect(isComposeOwnedVolume(external)).toBe(false);
    expect(isComposeOwnedNetwork(projectNetwork)).toBe(true);
    expect(isComposeOwnedNetwork(external)).toBe(false);
    expect(isComposeOwnedContainer({ Labels: { 'wiolett.gateway.compose.sidecar': 'true' } })).toBe(true);
  });

  it('removes untouched missing discoveries but preserves user-touched external projects', () => {
    const plan = planExternalComposeProjectReconciliation(
      [
        { id: 'external-missing', name: 'old', managementState: 'external', preserveWhenMissing: true },
        { id: 'external-remove', name: 'ephemeral', managementState: 'external' },
        { id: 'managed-missing', name: 'managed', managementState: 'managed' },
        { id: 'external-seen', name: 'seen', managementState: 'external' },
      ],
      [{ name: 'seen', observedFingerprint: 'fingerprint' }]
    );

    expect(plan.create).toEqual([]);
    expect(plan.missingExternal).toEqual([
      { id: 'external-missing', name: 'old', managementState: 'external', preserveWhenMissing: true },
    ]);
    expect(plan.removeMissingExternal).toEqual([
      { id: 'external-remove', name: 'ephemeral', managementState: 'external' },
    ]);
    expect(plan.observed).toEqual([
      {
        project: { name: 'seen', observedFingerprint: 'fingerprint' },
        existing: { id: 'external-seen', name: 'seen', managementState: 'external' },
      },
    ]);
  });

  it('upserts absent projects and updates only the observed external state', async () => {
    const insertValues = vi.fn(() => ({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }));
    const updateValues = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            leftJoin: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ id: 'project-uuid', name: 'demo' }]) })),
        }),
      insert: vi.fn(() => ({ values: insertValues })),
      update: vi.fn(() => ({ set: updateValues })),
    };

    const onChange = vi.fn();
    await reconcileExternalComposeProjects(
      db as never,
      '11111111-1111-4111-8111-111111111111',
      { containers: [{ Name: '/demo-api-1', Labels: { 'com.docker.compose.project': 'demo' } }] },
      new Date('2026-08-24T00:00:00.000Z'),
      onChange
    );

    expect(insertValues).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'demo',
        managementState: 'external',
        desiredState: 'running',
        status: 'discovered',
        availability: 'available',
      }),
    ]);
    expect(updateValues).toHaveBeenCalledWith(
      expect.objectContaining({ availability: 'available', observedFingerprint: expect.any(String) })
    );
    expect(insertValues).toHaveBeenLastCalledWith(
      expect.objectContaining({ resourceType: 'compose', resourceKey: 'project-uuid', containerName: null })
    );
    expect(onChange).toHaveBeenCalledWith({
      action: 'discovered',
      projectId: 'project-uuid',
      projectName: 'demo',
    });
  });
});
