import { describe, expect, it, vi } from 'vitest';
import { LocalClickHouseService } from './local-clickhouse.service.js';
import type { LoggingRuntimeSettings } from './logging-settings.service.js';

const LOCAL: LoggingRuntimeSettings = {
  mode: 'local',
  url: 'http://gateway-clickhouse:8123',
  username: 'gateway',
  password: 'secret',
  database: 'gateway_logs',
  table: 'logs',
  requestTimeoutMs: 5000,
  managedInternalLogs: false,
};

function docker() {
  return {
    listContainersByLabel: vi.fn().mockResolvedValue([]),
    stopContainer: vi.fn(),
    startContainer: vi.fn(),
    connectContainerToNetwork: vi.fn(),
    pullImage: vi.fn(),
    inspectSelf: vi.fn().mockResolvedValue({
      Config: { Labels: { 'com.docker.compose.project': 'gateway' } },
      HostConfig: { NetworkMode: 'gateway_default' },
    }),
    createContainer: vi.fn().mockResolvedValue('clickhouse-id'),
  };
}

describe('LocalClickHouseService', () => {
  it('creates a pinned, named container on the Gateway network with a persistent volume', async () => {
    const api = docker();
    await new LocalClickHouseService(api as any).reconcile(LOCAL);

    expect(api.pullImage).toHaveBeenCalledWith('clickhouse/clickhouse-server', '26.2.10.10');
    expect(api.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        Image: 'clickhouse/clickhouse-server:26.2.10.10',
        Labels: {
          'net.wiolett.gateway.managed': 'clickhouse',
          'net.wiolett.gateway.owner': 'gateway',
        },
        NetworkingConfig: {
          EndpointsConfig: { gateway_default: { Aliases: ['gateway-clickhouse'] } },
        },
        HostConfig: expect.objectContaining({
          Binds: ['gateway_clickhouse_data:/var/lib/clickhouse'],
          NetworkMode: 'gateway_default',
        }),
      }),
      'gateway-clickhouse'
    );
    expect(api.startContainer).toHaveBeenCalledWith('clickhouse-id');
  });

  it('keeps the stable ClickHouse network alias for a custom Compose project', async () => {
    const api = docker();
    api.inspectSelf.mockResolvedValueOnce({
      Config: { Labels: { 'com.docker.compose.project': 'gateway-prod' } },
      HostConfig: { NetworkMode: 'gateway-prod_default' },
    });

    await new LocalClickHouseService(api as any).reconcile(LOCAL);

    expect(api.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        NetworkingConfig: {
          EndpointsConfig: { 'gateway-prod_default': { Aliases: ['gateway-clickhouse'] } },
        },
      }),
      'gateway-prod-clickhouse'
    );
  });

  it('stops the managed container without deleting it when logging is disabled', async () => {
    const api = docker();
    api.listContainersByLabel.mockResolvedValueOnce([
      {
        Id: 'clickhouse-id',
        Names: ['/gateway-clickhouse'],
        State: 'running',
        Labels: { 'net.wiolett.gateway.owner': 'gateway' },
      },
    ]);
    await new LocalClickHouseService(api as any).reconcile({ ...LOCAL, mode: 'disabled' });

    expect(api.stopContainer).toHaveBeenCalledWith('clickhouse-id');
    expect(api.createContainer).not.toHaveBeenCalled();
  });

  it('does not stop a managed ClickHouse container owned by another Gateway project', async () => {
    const api = docker();
    api.listContainersByLabel.mockResolvedValueOnce([
      {
        Id: 'foreign-clickhouse',
        Names: ['/another-clickhouse'],
        State: 'running',
        Labels: { 'net.wiolett.gateway.owner': 'another' },
      },
    ]);

    await new LocalClickHouseService(api as any).reconcile({ ...LOCAL, mode: 'disabled' });

    expect(api.stopContainer).not.toHaveBeenCalled();
  });

  it('adopts the legacy compose ClickHouse container before creating a new one', async () => {
    const api = docker();
    api.listContainersByLabel.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        Id: 'legacy-clickhouse',
        Names: ['/gateway-clickhouse-1'],
        State: 'exited',
        Labels: { 'com.docker.compose.project': 'gateway' },
      },
    ]);
    await new LocalClickHouseService(api as any).reconcile({ ...LOCAL, url: 'http://clickhouse:8123' });

    expect(api.connectContainerToNetwork).toHaveBeenCalledWith('legacy-clickhouse', 'gateway_default', [
      'gateway-clickhouse',
    ]);
    expect(api.startContainer).toHaveBeenCalledWith('legacy-clickhouse');
    expect(api.createContainer).not.toHaveBeenCalled();
  });

  it('does not adopt a legacy ClickHouse container from another Compose project', async () => {
    const api = docker();
    api.listContainersByLabel.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        Id: 'foreign-clickhouse',
        Names: ['/foreign-clickhouse-1'],
        State: 'exited',
        Labels: { 'com.docker.compose.project': 'another-project' },
      },
    ]);

    await new LocalClickHouseService(api as any).reconcile({ ...LOCAL, url: 'http://clickhouse:8123' });

    expect(api.startContainer).toHaveBeenCalledWith('clickhouse-id');
    expect(api.startContainer).not.toHaveBeenCalledWith('foreign-clickhouse');
    expect(api.createContainer).toHaveBeenCalledOnce();
  });
});
