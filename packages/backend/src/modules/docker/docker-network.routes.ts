import type { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { requireScopeForResource } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import {
  connectNetworkRoute,
  createNetworkRoute,
  disconnectNetworkRoute,
  listNetworksRoute,
  removeNetworkRoute,
} from './docker.docs.js';
import { NetworkConnectSchema, NetworkCreateSchema } from './docker.schemas.js';
import { DockerManagementService } from './docker.service.js';
import { isGatewayManagedDockerNetwork } from './docker-internal-networks.js';
import { DockerSnapshotService } from './docker-snapshot.service.js';

const DOCKER_RESOURCE_LIST_MAX = 1000;
const DOCKER_NETWORK_CONTAINER_PREVIEW_MAX = 100;
const DOCKER_NETWORK_IPAM_CONFIG_MAX = 8;

function compactNetworkContainers(containers: unknown) {
  if (!containers || typeof containers !== 'object') return undefined;
  const entries = Object.entries(containers as Record<string, any>);
  return Object.fromEntries(
    entries.slice(0, DOCKER_NETWORK_CONTAINER_PREVIEW_MAX).map(([id, endpoint]) => [
      id,
      {
        name: endpoint?.name ?? endpoint?.Name,
      },
    ])
  );
}

function compactNetworkIpam(ipam: any) {
  const config = ipam?.config ?? ipam?.Config;
  if (!Array.isArray(config)) return undefined;
  return {
    config: config.slice(0, DOCKER_NETWORK_IPAM_CONFIG_MAX).map((entry: any) => ({
      subnet: entry.subnet ?? entry.Subnet,
      gateway: entry.gateway ?? entry.Gateway,
    })),
  };
}

export function compactNetworkListItem(network: Record<string, any>) {
  const containers = network.containers ?? network.Containers;
  const containerEntries = containers && typeof containers === 'object' ? Object.entries(containers) : [];
  return {
    id: network.id ?? network.Id,
    name: network.name ?? network.Name,
    driver: network.driver ?? network.Driver,
    scope: network.scope ?? network.Scope,
    created: network.created ?? network.Created,
    internal: network.internal ?? network.Internal,
    attachable: network.attachable ?? network.Attachable,
    ingress: network.ingress ?? network.Ingress,
    containers: compactNetworkContainers(containers),
    containersCount: containerEntries.length,
    containersTruncated: containerEntries.length > DOCKER_NETWORK_CONTAINER_PREVIEW_MAX,
    ipam: compactNetworkIpam(network.ipam ?? network.IPAM),
  };
}

export function matchesNetworkSearch(network: ReturnType<typeof compactNetworkListItem>, search: string | undefined) {
  if (!search) return true;
  const haystack = [network.id, network.name, network.driver, network.scope].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(search);
}

export function registerNetworkRoutes(router: OpenAPIHono<AppEnv>) {
  // ─── Network routes ──────────────────────────────────────────────────

  // List networks
  router.openapi(
    { ...listNetworksRoute, middleware: requireScopeForResource('docker:networks:view', 'nodeId') },
    async (c) => {
      const snapshots = container.resolve(DockerSnapshotService);
      const nodeId = c.req.param('nodeId')!;
      await snapshots.assertDockerNode(nodeId);
      const snapshot = await snapshots.getList<any[]>(nodeId, 'networks');
      const data = snapshot.data;
      if (!Array.isArray(data)) return c.json({ data });
      const search = c.req.query('search')?.trim().toLowerCase();
      const compacted = data
        .filter((item) => !isGatewayManagedDockerNetwork(String(item.name ?? item.Name ?? '')))
        .map((item) => ({
          ...compactNetworkListItem(item),
          nodeId,
          availability: snapshots.availability(nodeId, snapshot),
        }))
        .filter((item) => matchesNetworkSearch(item, search));
      const truncated = compacted.length > DOCKER_RESOURCE_LIST_MAX;
      return c.json({
        data: truncated ? compacted.slice(0, DOCKER_RESOURCE_LIST_MAX) : compacted,
        total: compacted.length,
        limit: DOCKER_RESOURCE_LIST_MAX,
        truncated,
      });
    }
  );

  // Create network
  router.openapi(
    { ...createNetworkRoute, middleware: requireScopeForResource('docker:networks:create', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const user = c.get('user')!;
      const body = await c.req.json();
      const config = NetworkCreateSchema.parse(body);
      const data = await service.createNetwork(nodeId, config, user.id);
      return c.json({ data }, 201);
    }
  );

  // Remove network
  router.openapi(
    { ...removeNetworkRoute, middleware: requireScopeForResource('docker:networks:delete', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const networkId = c.req.param('networkId')!;
      const user = c.get('user')!;
      await service.removeNetwork(nodeId, networkId, user.id);
      return c.json({ success: true });
    }
  );

  // Connect container to network
  router.openapi(
    { ...connectNetworkRoute, middleware: requireScopeForResource('docker:networks:edit', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const networkId = c.req.param('networkId')!;
      const user = c.get('user')!;
      const body = await c.req.json();
      const { containerId } = NetworkConnectSchema.parse(body);
      await service.connectContainerToNetwork(nodeId, networkId, containerId, user.id);
      return c.json({ success: true });
    }
  );

  // Disconnect container from network
  router.openapi(
    { ...disconnectNetworkRoute, middleware: requireScopeForResource('docker:networks:edit', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const networkId = c.req.param('networkId')!;
      const user = c.get('user')!;
      const body = await c.req.json();
      const { containerId } = NetworkConnectSchema.parse(body);
      await service.disconnectContainerFromNetwork(nodeId, networkId, containerId, user.id);
      return c.json({ success: true });
    }
  );
}
