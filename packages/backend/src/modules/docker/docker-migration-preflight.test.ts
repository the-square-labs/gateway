import { describe, expect, it } from 'vitest';
import { DockerMigrationPreflightService } from './docker-migration-preflight.js';

function preflightService() {
  return new DockerMigrationPreflightService({} as any, {} as any, {} as any, {} as any);
}

describe('DockerMigrationPreflightService GPU portability guards', () => {
  it('blocks a managed or unknown GPU container before generic device validation', () => {
    const blockers: any[] = [];

    (preflightService() as any).checkHostBoundSettings(
      {
        gpuAttachment: { mode: 'managed', deviceIds: ['nvidia:GPU-1'] },
        HostConfig: { DeviceRequests: [{ Driver: 'nvidia', DeviceIDs: ['GPU-1'] }] },
      },
      blockers
    );

    expect(blockers).toEqual([
      {
        code: 'GPU_MIGRATION_UNSUPPORTED',
        message: 'GPU-mapped containers cannot be migrated in this version',
      },
    ]);
  });

  it('blocks a blue/green deployment when its desired configuration selects a GPU', () => {
    const blockers: any[] = [];

    (preflightService() as any).checkDeploymentGpuSelection(
      {
        desiredConfig: { image: 'app:latest', gpu: { deviceIds: ['nvidia:GPU-1'] } },
        slots: [{ desiredConfig: { image: 'app:latest', gpu: { deviceIds: ['nvidia:GPU-1'] } } }],
      },
      blockers,
      'api'
    );

    expect(blockers).toContainEqual({
      code: 'GPU_MIGRATION_UNSUPPORTED',
      message: 'GPU-mapped deployments cannot be migrated in this version',
      resource: 'api',
    });
  });
});
