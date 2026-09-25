const SECURE_LINK_MANAGED_LABEL = 'wiolett.gateway.managed';
const MANAGED_DATABASE_CONNECTOR_LABEL = 'wiolett.gateway.managed-database.connector';
const MANAGED_STORAGE_CONNECTOR_LABEL = 'wiolett.gateway.managed-storage.connector';
const INTERNAL_WORKLOAD_LABEL = 'wiolett.gateway.internal-workload';
const LOCAL_SERVICE_MANAGED_LABEL = 'net.wiolett.gateway.managed';
const LOCAL_SERVICE_OWNER_LABEL = 'net.wiolett.gateway.owner';
const FOUNDATION_SERVICE_LABEL = 'com.wiolett.gateway.managed-service';
const SANDBOX_LABEL = 'gateway.sandbox';
const AVAILABILITY_PLACEMENT_LABEL = 'wiolett.gateway.availability.managed';
// Backup runners carry storage credentials in their config while a run is active.
const BACKUP_RUN_LABEL = 'wiolett.gateway.backup-run-id';

function containerLabels(container: Record<string, any>): Record<string, unknown> {
  return container?.Config?.Labels ?? container?.Labels ?? container?.labels ?? {};
}

/**
 * Gateway-owned implementation containers must remain available to internal
 * reconciliation, but must not be exposed as user-managed Docker resources.
 */
export function isGatewayInternalContainer(container: Record<string, any>): boolean {
  const labels = containerLabels(container);
  return (
    labels[SECURE_LINK_MANAGED_LABEL] === 'secure-link-connector' ||
    labels[SECURE_LINK_MANAGED_LABEL] === 'backup-runner' ||
    labels[SECURE_LINK_MANAGED_LABEL] === 'backup-redis-stage' ||
    (typeof labels[BACKUP_RUN_LABEL] === 'string' && labels[BACKUP_RUN_LABEL] !== '') ||
    labels[MANAGED_DATABASE_CONNECTOR_LABEL] === 'true' ||
    labels[MANAGED_STORAGE_CONNECTOR_LABEL] === 'true' ||
    labels[INTERNAL_WORKLOAD_LABEL] === 'managed-storage-connector' ||
    (labels[LOCAL_SERVICE_MANAGED_LABEL] === 'clickhouse' && labels[LOCAL_SERVICE_OWNER_LABEL] === 'gateway') ||
    (typeof labels[FOUNDATION_SERVICE_LABEL] === 'string' && labels[FOUNDATION_SERVICE_LABEL] !== '') ||
    labels[SANDBOX_LABEL] === 'true' ||
    labels[AVAILABILITY_PLACEMENT_LABEL] === 'true'
  );
}

export function filterGatewayInternalContainers<T extends Record<string, any>>(containers: T[]): T[] {
  return containers.filter((container) => !isGatewayInternalContainer(container));
}

export function assertUserContainerAccessible(container: Record<string, any> | null | undefined): void {
  if (container && isGatewayInternalContainer(container)) {
    throw new AppError(404, 'GATEWAY_INTERNAL_CONTAINER', 'Container not found');
  }
}

export async function inspectUserContainer(
  inspector: { inspectContainer(nodeId: string, containerId: string): Promise<any> },
  nodeId: string,
  containerId: string
) {
  const data = await inspector.inspectContainer(nodeId, containerId);
  assertUserContainerAccessible(data);
  return data;
}

import { AppError } from '@/middleware/error-handler.js';
