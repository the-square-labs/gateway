import type { IntegrationConnectorCapabilities, IntegrationProvider } from '@/db/schema/index.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';

type RequiredScopes = string | readonly string[];

export interface ConnectorOperationAccessInput {
  actor: {
    userId?: string | null;
    scopes: readonly string[];
  };
  provider: IntegrationProvider;
  connectorId?: string | null;
  connectorName?: string | null;
  project?: {
    remoteId?: string | null;
    fullPath?: string | null;
    name?: string | null;
  } | null;
  operation: string;
  requiredScope: RequiredScopes;
  capabilities?: IntegrationConnectorCapabilities | null;
  requiredCapability?: keyof IntegrationConnectorCapabilities;
  projectAllowed?: boolean;
}

export interface ConnectorOperationAccessResult {
  provider: IntegrationProvider;
  connectorId: string | null;
  connectorName: string | null;
  project: ConnectorOperationAccessInput['project'];
  operation: string;
  grantedScope: string;
}

function normalizeScopes(requiredScope: RequiredScopes): string[] {
  return typeof requiredScope === 'string' ? [requiredScope] : [...requiredScope];
}

export function assertConnectorOperationAccess(input: ConnectorOperationAccessInput): ConnectorOperationAccessResult {
  const requiredScopes = normalizeScopes(input.requiredScope);
  const grantedScope = requiredScopes.find((scope) => hasScope([...input.actor.scopes], scope));
  if (!grantedScope) {
    throw new AppError(403, 'CONNECTOR_SCOPE_DENIED', 'Missing required connector scope', {
      provider: input.provider,
      connectorId: input.connectorId ?? null,
      operation: input.operation,
      requiredScopes,
      scopeMatch: 'any',
    });
  }

  if (input.requiredCapability && input.capabilities?.[input.requiredCapability] !== true) {
    throw new AppError(403, 'CONNECTOR_CAPABILITY_DENIED', 'Connector token does not allow this operation', {
      provider: input.provider,
      connectorId: input.connectorId ?? null,
      operation: input.operation,
      requiredCapability: input.requiredCapability,
    });
  }

  if (input.projectAllowed === false) {
    throw new AppError(403, 'CONNECTOR_PROJECT_NOT_ALLOWED', 'Project is outside the connector allowlist', {
      provider: input.provider,
      connectorId: input.connectorId ?? null,
      operation: input.operation,
      projectRemoteId: input.project?.remoteId ?? null,
      projectFullPath: input.project?.fullPath ?? null,
    });
  }

  return {
    provider: input.provider,
    connectorId: input.connectorId ?? null,
    connectorName: input.connectorName ?? null,
    project: input.project ?? null,
    operation: input.operation,
    grantedScope,
  };
}
