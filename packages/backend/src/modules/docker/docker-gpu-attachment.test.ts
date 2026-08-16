import { describe, expect, it, vi } from 'vitest';
import { recreateWithConfig } from './docker-container-mutation-operations.js';
import {
  deriveDockerGpuAttachment,
  dockerGpuAttachmentFromInspect,
  hasDockerGpuV1Capability,
  hasRequestedGpuChange,
} from './docker-gpu-attachment.js';

const inventory = [
  { id: 'nvidia:GPU-1', vendor: 'nvidia' },
  { id: 'amd:0000:01:00.0', vendor: 'amd', renderNode: '/dev/dri/renderD128' },
  { id: 'intel:0000:00:02.0', vendor: 'intel', renderNode: '/dev/dri/renderD129' },
];

describe('deriveDockerGpuAttachment', () => {
  it('normalizes daemon-owned NVIDIA and AMD mappings to node GPU IDs', () => {
    expect(
      deriveDockerGpuAttachment(
        {
          HostConfig: {
            DeviceRequests: [{ Driver: 'nvidia', DeviceIDs: ['GPU-1'], Capabilities: [['gpu']] }],
            Devices: [
              { PathOnHost: '/dev/kfd', PathInContainer: '/dev/kfd' },
              { PathOnHost: '/dev/dri/renderD128', PathInContainer: '/dev/dri/renderD128' },
            ],
          },
        },
        inventory
      )
    ).toEqual({ mode: 'managed', deviceIds: ['nvidia:GPU-1', 'amd:0000:01:00.0'] });
  });

  it('normalizes Docker CLI explicit NVIDIA device requests without a Driver', () => {
    expect(
      deriveDockerGpuAttachment(
        {
          HostConfig: {
            DeviceRequests: [
              {
                Driver: '',
                Count: 0,
                DeviceIDs: ['GPU-1'],
                Capabilities: [['gpu']],
                Options: {},
              },
            ],
          },
        },
        inventory
      )
    ).toEqual({ mode: 'managed', deviceIds: ['nvidia:GPU-1'] });
  });

  it('keeps custom driverless GPU requests read-only', () => {
    expect(
      deriveDockerGpuAttachment(
        {
          HostConfig: {
            DeviceRequests: [
              {
                Driver: '',
                Count: 0,
                DeviceIDs: ['GPU-1'],
                Capabilities: [['gpu']],
                Options: { capabilities: 'compute,utility' },
              },
            ],
          },
        },
        inventory
      )
    ).toMatchObject({ mode: 'external', reason: expect.any(String) });
  });

  it('keeps custom NVIDIA driver requests read-only', () => {
    expect(
      deriveDockerGpuAttachment(
        {
          HostConfig: {
            DeviceRequests: [
              {
                Driver: 'nvidia',
                Count: 0,
                DeviceIDs: ['GPU-1'],
                Capabilities: [['gpu', 'compute']],
                Options: { capabilities: 'compute,utility' },
              },
            ],
          },
        },
        inventory
      )
    ).toMatchObject({ mode: 'external', reason: expect.any(String) });
  });

  it('keeps unknown, legacy, and partial GPU mappings read-only', () => {
    expect(
      deriveDockerGpuAttachment(
        { HostConfig: { Runtime: 'nvidia', DeviceRequests: [{ Driver: 'nvidia', DeviceIDs: ['GPU-unknown'] }] } },
        inventory
      )
    ).toMatchObject({ mode: 'external', deviceIds: [], reason: expect.any(String) });

    expect(
      deriveDockerGpuAttachment(
        { HostConfig: { Devices: [{ PathOnHost: '/dev/kfd', PathInContainer: '/dev/kfd' }] } },
        inventory
      )
    ).toMatchObject({ mode: 'external', deviceIds: [], reason: expect.any(String) });
  });

  it('does not infer a GPU attachment without a Docker GPU mapping', () => {
    expect(deriveDockerGpuAttachment({ HostConfig: { Devices: [{ PathOnHost: '/dev/random' }] } }, inventory)).toEqual({
      mode: 'none',
      deviceIds: [],
    });
  });

  it('uses a previously normalized attachment for recreate protection', () => {
    expect(
      dockerGpuAttachmentFromInspect({ gpuAttachment: { mode: 'external', deviceIds: [], reason: 'unmanaged' } })
    ).toEqual({ mode: 'external', deviceIds: [], reason: 'unmanaged' });
    expect(hasRequestedGpuChange({ gpu: { deviceIds: [] } })).toBe(true);
    expect(hasRequestedGpuChange({})).toBe(false);
  });

  it('recognizes only explicitly advertised GPU-capable Docker daemons', () => {
    expect(hasDockerGpuV1Capability({ capabilities: ['docker_deployments_v1'] })).toBe(false);
    expect(hasDockerGpuV1Capability({ capabilities: ['docker_gpu_v1'] })).toBe(true);
    expect(hasDockerGpuV1Capability({ dockerGpuV1: true })).toBe(true);
  });

  it('blocks a GPU rewrite before dispatch when the current mapping is external', async () => {
    const dispatch = { sendDockerContainerCommand: vi.fn() };
    const mutationContext = {
      validateDockerNode: vi.fn().mockResolvedValue(undefined),
      assertNotManagedDeploymentInternal: vi.fn().mockResolvedValue(undefined),
      assertDockerGpuCapability: vi.fn().mockResolvedValue(undefined),
      assertDockerRuntimeProfileAvailable: vi.fn().mockResolvedValue(undefined),
      resolveContainerName: vi.fn().mockResolvedValue('api'),
      resolveExpectedRecreateState: vi.fn().mockResolvedValue('running'),
      requireNoTransition: vi.fn(),
      runtimeOperationContext: () => ({ runtimeSettingsService: undefined }),
      inspectContainer: vi.fn().mockResolvedValue({
        Name: '/api',
        gpuAttachment: { mode: 'external', deviceIds: [], reason: 'legacy mapping' },
      }),
      nodeDispatch: dispatch,
    };

    await expect(
      recreateWithConfig(mutationContext as never, 'node-1', 'container-1', { gpu: { deviceIds: [] } }, 'user-1')
    ).rejects.toMatchObject({ code: 'GPU_ATTACHMENT_UNMANAGED' });
    expect(dispatch.sendDockerContainerCommand).not.toHaveBeenCalled();
  });

  it('rejects an explicit GPU change before inspection when the daemon lacks GPU support', async () => {
    const dispatch = { sendDockerContainerCommand: vi.fn() };
    const mutationContext = {
      validateDockerNode: vi.fn().mockResolvedValue(undefined),
      assertNotManagedDeploymentInternal: vi.fn().mockResolvedValue(undefined),
      assertDockerGpuCapability: vi.fn().mockRejectedValue({ code: 'UNSUPPORTED_DAEMON' }),
      nodeDispatch: dispatch,
    };

    await expect(
      recreateWithConfig(mutationContext as never, 'node-1', 'container-1', { gpu: { deviceIds: [] } }, 'user-1')
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_DAEMON' });
    expect(mutationContext.assertDockerGpuCapability).toHaveBeenCalledWith('node-1');
    expect(dispatch.sendDockerContainerCommand).not.toHaveBeenCalled();
  });
});
