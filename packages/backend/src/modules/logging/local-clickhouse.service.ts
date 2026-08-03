import { createChildLogger } from '@/lib/logger.js';
import type { DockerService } from '@/services/docker.service.js';
import type { LoggingRuntimeSettings } from './logging-settings.service.js';

const logger = createChildLogger('LocalClickHouse');
const MANAGED_LABEL = 'net.wiolett.gateway.managed=clickhouse';
const OWNER_LABEL = 'net.wiolett.gateway.owner';
const IMAGE = 'clickhouse/clickhouse-server';
const TAG = '26.2.10.10';

export class LocalClickHouseService {
  constructor(private readonly docker: DockerService) {}

  async reconcile(config: LoggingRuntimeSettings): Promise<void> {
    const self = await this.docker.inspectSelf();
    const composeProject = self.Config.Labels?.['com.docker.compose.project'];
    if (!composeProject) throw new Error('Cannot determine the Gateway Compose project for managed ClickHouse');
    const owner = composeProject;
    const safeOwner = owner.replace(/[^a-zA-Z0-9_.-]/g, '-');
    const containerName = `${safeOwner}-clickhouse`;
    const volumeName = `${safeOwner}_clickhouse_data`;
    const networkMode = self.HostConfig?.NetworkMode;
    const managed = await this.docker.listContainersByLabel(MANAGED_LABEL);
    const managedContainer = managed.find(
      (container) => container.Labels?.[OWNER_LABEL] === owner && container.Names.includes(`/${containerName}`)
    );
    const configuredHostname = config.mode === 'local' ? new URL(config.url).hostname : '';
    const legacy = managedContainer
      ? []
      : await this.docker.listContainersByLabel('com.docker.compose.service=clickhouse');
    const legacyContainer =
      configuredHostname === 'clickhouse' && composeProject
        ? legacy.find((container) => container.Labels?.['com.docker.compose.project'] === composeProject)
        : undefined;
    const existing = managedContainer ?? legacyContainer;

    if (config.mode !== 'local') {
      if (existing?.State === 'running') {
        await this.docker.stopContainer(existing.Id);
        logger.info('Stopped local ClickHouse; persistent data was preserved', { containerId: existing.Id });
      }
      return;
    }

    if (existing) {
      if (networkMode) await this.docker.connectContainerToNetwork(existing.Id, networkMode, ['gateway-clickhouse']);
      await this.docker.startContainer(existing.Id);
      logger.info('Adopted existing local ClickHouse container', {
        containerId: existing.Id,
        legacy: !managedContainer,
      });
      return;
    }

    await this.docker.pullImage(IMAGE, TAG);
    const id = await this.docker.createContainer(
      {
        Image: `${IMAGE}:${TAG}`,
        Env: [
          `CLICKHOUSE_DB=${config.database}`,
          `CLICKHOUSE_USER=${config.username}`,
          `CLICKHOUSE_PASSWORD=${config.password}`,
        ],
        Labels: {
          'net.wiolett.gateway.managed': 'clickhouse',
          [OWNER_LABEL]: owner,
        },
        ...(networkMode
          ? {
              NetworkingConfig: {
                EndpointsConfig: { [networkMode]: { Aliases: ['gateway-clickhouse'] } },
              },
            }
          : {}),
        HostConfig: {
          Binds: [`${volumeName}:/var/lib/clickhouse`],
          ...(networkMode ? { NetworkMode: networkMode } : {}),
          RestartPolicy: { Name: 'unless-stopped' },
          LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
        },
      },
      containerName
    );
    await this.docker.startContainer(id);
    logger.info('Created managed local ClickHouse container', { containerId: id });
  }
}
