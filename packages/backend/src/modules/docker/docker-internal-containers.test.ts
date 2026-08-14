import { describe, expect, it } from 'vitest';
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
});
