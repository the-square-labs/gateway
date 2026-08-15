const SECURE_LINK_MANAGED_LABEL = 'wiolett.gateway.managed';
const MANAGED_DATABASE_CONNECTOR_LABEL = 'wiolett.gateway.managed-database.connector';
const LOCAL_SERVICE_MANAGED_LABEL = 'net.wiolett.gateway.managed';
const LOCAL_SERVICE_OWNER_LABEL = 'net.wiolett.gateway.owner';
const FOUNDATION_SERVICE_LABEL = 'com.wiolett.gateway.managed-service';
const SANDBOX_LABEL = 'gateway.sandbox';

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
    labels[MANAGED_DATABASE_CONNECTOR_LABEL] === 'true' ||
    (labels[LOCAL_SERVICE_MANAGED_LABEL] === 'clickhouse' && labels[LOCAL_SERVICE_OWNER_LABEL] === 'gateway') ||
    (typeof labels[FOUNDATION_SERVICE_LABEL] === 'string' && labels[FOUNDATION_SERVICE_LABEL] !== '') ||
    labels[SANDBOX_LABEL] === 'true'
  );
}

export function filterGatewayInternalContainers<T extends Record<string, any>>(containers: T[]): T[] {
  return containers.filter((container) => !isGatewayInternalContainer(container));
}
