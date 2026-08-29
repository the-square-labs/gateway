import { describe, expect, it, vi } from 'vitest';
import { DockerManagementService } from './docker.service.js';
import { filterGatewayInternalContainers, isGatewayInternalContainer } from './docker-internal-containers.js';

describe('Gateway internal container filtering', () => {
  it.each([
    { Labels: { 'wiolett.gateway.managed': 'secure-link-connector' } },
    { labels: { 'wiolett.gateway.managed-database.connector': 'true' } },
    {
      Config: {
        Labels: {
          'net.wiolett.gateway.managed': 'clickhouse',
          'net.wiolett.gateway.owner': 'gateway',
        },
      },
    },
    { Labels: { 'com.wiolett.gateway.managed-service': 'relay' } },
    { Labels: { 'gateway.sandbox': 'true' } },
  ])('recognizes a Gateway-owned service container', (container) => {
    expect(isGatewayInternalContainer(container)).toBe(true);
  });

  it.each([
    { Labels: { app: 'api' } },
    { Labels: { 'wiolett.gateway.managed-database.id': 'postgres-main' } },
    { Labels: { 'wiolett.gateway.deployment.managed': 'true' } },
    {
      Labels: {
        'net.wiolett.gateway.managed': 'clickhouse',
        'net.wiolett.gateway.owner': 'another',
      },
    },
  ])('keeps user-managed containers', (container) => {
    expect(isGatewayInternalContainer(container)).toBe(false);
  });

  it('removes only internal containers from a mixed inventory', () => {
    const user = { Id: 'user', Labels: { app: 'api' } };
    const connector = {
      Id: 'connector',
      Labels: { 'wiolett.gateway.managed': 'secure-link-connector' },
    };

    expect(filterGatewayInternalContainers([user, connector])).toEqual([user]);
  });

  it('keeps the full inventory internally while filtering the public read model', async () => {
    const service = new DockerManagementService({} as never, {} as never, {} as never, {} as never);
    const user = { Id: 'user', Name: '/api', Labels: { app: 'api' } };
    const connector = {
      Id: 'connector',
      Name: '/gateway-secure-link-connector',
      Labels: { 'wiolett.gateway.managed': 'secure-link-connector' },
    };

    await expect(service.decorateContainerSnapshot('node-1', [user, connector])).resolves.toEqual([user, connector]);
    await expect(service.decoratePublicContainerSnapshot('node-1', [user, connector])).resolves.toEqual([user]);
  });

  it.each([
    { 'wiolett.gateway.managed': 'secure-link-connector' },
    { 'wiolett.gateway.managed-database.connector': 'true' },
    { 'net.wiolett.gateway.managed': 'clickhouse', 'net.wiolett.gateway.owner': 'gateway' },
    { 'com.wiolett.gateway.managed-service': 'relay' },
    { 'gateway.sandbox': 'true' },
  ])('rejects user mutations of every Gateway-owned container class', async (labels) => {
    const nodeDispatch = {
      sendDockerContainerCommand: vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify({
          Config: { Labels: labels },
        }),
      }),
    };
    const service = new DockerManagementService(
      {} as never,
      {} as never,
      nodeDispatch as never,
      { getNode: vi.fn().mockReturnValue(undefined) } as never
    );

    await expect(
      (
        service as unknown as {
          assertContainerMutationAllowed(nodeId: string, containerId: string): Promise<void>;
        }
      ).assertContainerMutationAllowed('node-1', 'connector-1')
    ).rejects.toMatchObject({ statusCode: 409, code: 'GATEWAY_INTERNAL_CONTAINER' });
    expect(nodeDispatch.sendDockerContainerCommand).toHaveBeenCalledTimes(1);
    expect(nodeDispatch.sendDockerContainerCommand).toHaveBeenCalledWith('node-1', 'inspect', {
      containerId: 'connector-1',
    });
  });

  it.each([
    { 'wiolett.gateway.managed': 'secure-link-connector' },
    { 'wiolett.gateway.managed-database.connector': 'true' },
    { 'net.wiolett.gateway.managed': 'clickhouse', 'net.wiolett.gateway.owner': 'gateway' },
    { 'com.wiolett.gateway.managed-service': 'relay' },
    { 'gateway.sandbox': 'true' },
  ])('makes every Gateway-owned container class unavailable to user-facing inspection', async (labels) => {
    const nodeDispatch = {
      sendDockerContainerCommand: vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify({ Id: 'internal-1', Config: { Labels: labels } }),
      }),
    };
    const service = new DockerManagementService(
      {} as never,
      {} as never,
      nodeDispatch as never,
      { getNode: vi.fn().mockReturnValue(undefined) } as never
    );
    (service as any).validateDockerNode = vi.fn().mockResolvedValue(undefined);

    await expect(service.inspectUserContainer('node-1', 'internal-1')).rejects.toMatchObject({
      statusCode: 404,
      code: 'GATEWAY_INTERNAL_CONTAINER',
    });
    await expect(service.inspectContainer('node-1', 'internal-1')).resolves.toMatchObject({ Id: 'internal-1' });
  });

  it('keeps user-managed containers available through user-facing inspection', async () => {
    const nodeDispatch = {
      sendDockerContainerCommand: vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify({ Id: 'application-1', Config: { Labels: { app: 'api' } } }),
      }),
    };
    const service = new DockerManagementService(
      {} as never,
      {} as never,
      nodeDispatch as never,
      { getNode: vi.fn().mockReturnValue(undefined) } as never
    );
    (service as any).validateDockerNode = vi.fn().mockResolvedValue(undefined);

    await expect(service.inspectUserContainer('node-1', 'application-1')).resolves.toMatchObject({
      Id: 'application-1',
    });
  });

  it.each([
    [
      'network connect',
      (service: DockerManagementService) =>
        service.connectContainerToNetwork('node-1', 'net-1', 'internal-1', 'user-1'),
    ],
    [
      'network disconnect',
      (service: DockerManagementService) =>
        service.disconnectContainerFromNetwork('node-1', 'net-1', 'internal-1', 'user-1'),
    ],
    [
      'file write',
      (service: DockerManagementService) => service.writeFile('node-1', 'internal-1', '/tmp/a', 'x', 'user-1'),
    ],
    [
      'file create',
      (service: DockerManagementService) => service.createFile('node-1', 'internal-1', '/tmp/a', 'x', 'user-1'),
    ],
    [
      'upload initialization',
      (service: DockerManagementService) => service.initFileUpload('node-1', 'internal-1', '/tmp/a', 1, 'user-1'),
    ],
    [
      'upload chunk append',
      (service: DockerManagementService) =>
        service.appendFileUploadChunk('node-1', 'internal-1', 'upload-1', 0, Buffer.from('x')),
    ],
    [
      'upload completion',
      (service: DockerManagementService) => service.completeFileUpload('node-1', 'internal-1', 'upload-1', '/tmp/a', 1),
    ],
    ['upload abort', (service: DockerManagementService) => service.abortFileUpload('node-1', 'internal-1', 'upload-1')],
    [
      'directory creation',
      (service: DockerManagementService) => service.createDirectory('node-1', 'internal-1', '/tmp/a', 'user-1'),
    ],
    [
      'file deletion',
      (service: DockerManagementService) => service.deleteFile('node-1', 'internal-1', '/tmp/a', 'user-1'),
    ],
    [
      'file move',
      (service: DockerManagementService) => service.moveFile('node-1', 'internal-1', '/tmp/a', '/tmp/b', 'user-1'),
    ],
  ])('guards Gateway-owned containers before %s', async (_name, mutate) => {
    const service = new DockerManagementService(
      {} as never,
      {} as never,
      {
        sendDockerNetworkCommand: vi.fn().mockResolvedValue({
          success: true,
          detail: JSON.stringify([{ Id: 'net-1', Name: 'application-network' }]),
        }),
      } as never,
      {} as never
    ) as any;
    service.validateDockerNode = vi.fn().mockResolvedValue(undefined);
    service.assertContainerMutationAllowed = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('internal'), { code: 'GATEWAY_INTERNAL_CONTAINER' }));

    await expect(mutate(service)).rejects.toMatchObject({ code: 'GATEWAY_INTERNAL_CONTAINER' });
    expect(service.assertContainerMutationAllowed).toHaveBeenCalledWith('node-1', 'internal-1');
  });
});
