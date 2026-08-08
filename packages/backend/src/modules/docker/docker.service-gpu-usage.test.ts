import { describe, expect, it, vi } from 'vitest';
import { DockerManagementService } from './docker.service.js';

function dbWithOnlineDockerNode() {
  const limit = vi.fn().mockResolvedValue([
    {
      id: 'node-1',
      type: 'docker',
    },
  ]);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select };
}

describe('DockerManagementService GPU usage', () => {
  it('inspects only visible containers and returns managed GPU attachments', async () => {
    const dispatch = {
      sendDockerContainerCommand: vi.fn(async (_nodeId: string, action: string, options?: { containerId?: string }) => {
        if (action === 'list') {
          return {
            success: true,
            detail: JSON.stringify([
              { id: 'managed', name: 'trainer' },
              { id: 'external', name: 'legacy' },
              { id: 'hidden', name: 'hidden' },
              { id: 'gone', name: 'gone' },
            ]),
          };
        }
        if (options?.containerId === 'managed') {
          return {
            success: true,
            detail: JSON.stringify({
              Id: 'managed',
              Name: '/trainer',
              Config: { Labels: {} },
              HostConfig: {
                DeviceRequests: [{ Driver: 'nvidia', DeviceIDs: ['GPU-1'], Capabilities: [['gpu']] }],
              },
            }),
          };
        }
        if (options?.containerId === 'external') {
          return {
            success: true,
            detail: JSON.stringify({
              Id: 'external',
              Name: '/legacy',
              Config: { Labels: {} },
              HostConfig: { Runtime: 'nvidia' },
            }),
          };
        }
        return { success: false, error: 'No such container' };
      }),
    };
    const service = new DockerManagementService(
      dbWithOnlineDockerNode() as never,
      { log: vi.fn().mockResolvedValue(undefined) } as never,
      dispatch as never,
      {
        getNode: vi.fn().mockReturnValue({
          id: 'node-1',
          lastHealthReport: {
            gpuDevices: [{ id: 'nvidia:GPU-1', vendor: 'nvidia' }],
          },
        }),
      } as never
    );
    const accessResources = {
      listContainerResourceIdentities: vi.fn().mockResolvedValue([
        { id: 'resource-visible', name: 'trainer', runtimeId: 'managed' },
        { id: 'resource-external', name: 'legacy', runtimeId: 'external' },
        { id: 'resource-hidden', name: 'hidden', runtimeId: 'hidden' },
      ]),
      ensureContainer: vi.fn(),
    };
    service.setAccessResourceService(accessResources as never);

    await expect(
      service.listGpuAttachmentUsers('node-1', ['docker:containers:view:node-1/resource-visible'])
    ).resolves.toEqual([
      {
        containerId: 'managed',
        name: 'trainer',
        scopeResourceId: 'resource-visible',
        deviceIds: ['nvidia:GPU-1'],
      },
    ]);
    expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledWith('node-1', 'inspect', { containerId: 'managed' });
    expect(dispatch.sendDockerContainerCommand).not.toHaveBeenCalledWith('node-1', 'inspect', {
      containerId: 'hidden',
    });
    expect(accessResources.ensureContainer).not.toHaveBeenCalled();
  });
});
