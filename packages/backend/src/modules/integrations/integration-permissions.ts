import type { IntegrationConnectorCapabilities, IntegrationProvider } from '@/db/schema/index.js';
import {
  type GitRepositoryScopeTarget,
  gitGrantedConnectorIds,
  hasGitConnectorScope,
  hasGitRepositoryScope,
  hasGitScopeAnywhere,
  hasGitScopeOnConnector,
} from '@/lib/git-scopes.js';
import { hasScope } from '@/lib/permissions.js';
import { isGitScopeBase } from '@/lib/scopes-git.js';
import { AppError } from '@/middleware/error-handler.js';

type RequiredScopes = string | readonly string[];

/**
 * Where a Git scope must apply:
 * - `connector` (the default): the unqualified scope or the connector qualifier (managing the connection,
 *   connector details). Without a connectorId only the unqualified scope counts.
 * - `within-connector`: any qualifier on the connector, or on any connector without a connectorId. Listing
 *   endpoints use it and then filter their results per repository.
 * A `repository` switches to the repository check: connector, containing group/owner, or exact project/repo.
 */
export type ConnectorScopeTarget = 'connector' | 'within-connector';

export interface ConnectorOperationAccessInput {
  actor: {
    userId?: string | null;
    scopes: readonly string[];
    /**
     * The live scopes of the account behind a token or OAuth grant. Git scopes must then be granted by both
     * sets: a token keeps narrow Git scopes whose containment only the provider knows (boundScopes step 4).
     */
    accountScopes?: readonly string[] | null;
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
  scopeTarget?: ConnectorScopeTarget;
  /** The repository the operation acts on; Git scopes are then matched against its qualifiers. */
  repository?: Omit<GitRepositoryScopeTarget, 'connectorId'> | null;
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

/** Whether the actor holds one required scope where the operation applies (see ConnectorScopeTarget). */
export function holdsConnectorOperationScope(
  input: Pick<ConnectorOperationAccessInput, 'actor' | 'connectorId' | 'scopeTarget' | 'repository'>,
  requiredScope: string
): boolean {
  if (!isGitScopeBase(requiredScope)) return hasScope([...input.actor.scopes], requiredScope);
  const scopeSets = input.actor.accountScopes ? [input.actor.scopes, input.actor.accountScopes] : [input.actor.scopes];
  return scopeSets.every((scopes) => holdsGitScope(scopes, input, requiredScope));
}

function holdsGitScope(
  scopes: readonly string[],
  input: Pick<ConnectorOperationAccessInput, 'connectorId' | 'scopeTarget' | 'repository'>,
  requiredScope: string
): boolean {
  const connectorId = input.connectorId ?? null;
  if (input.repository && connectorId) {
    return hasGitRepositoryScope(scopes, requiredScope, { ...input.repository, connectorId });
  }
  if (input.scopeTarget === 'within-connector') {
    return connectorId
      ? hasGitScopeOnConnector(scopes, requiredScope, connectorId)
      : hasGitScopeAnywhere(scopes, requiredScope);
  }
  return connectorId ? hasGitConnectorScope(scopes, requiredScope, connectorId) : hasScope([...scopes], requiredScope);
}

function repositoryLabel(input: ConnectorOperationAccessInput): string | null {
  return input.project?.fullPath ?? input.project?.name ?? input.project?.remoteId ?? null;
}

export function assertConnectorOperationAccess(input: ConnectorOperationAccessInput): ConnectorOperationAccessResult {
  const requiredScopes = normalizeScopes(input.requiredScope);
  const grantedScope = requiredScopes.find((scope) => holdsConnectorOperationScope(input, scope));
  if (!grantedScope) {
    const repository = input.repository ? repositoryLabel(input) : null;
    throw new AppError(
      403,
      'CONNECTOR_SCOPE_DENIED',
      repository ? `Access to repository ${repository} is not granted` : 'Missing required connector scope',
      {
        provider: input.provider,
        connectorId: input.connectorId ?? null,
        operation: input.operation,
        requiredScopes,
        scopeMatch: 'any',
        ...(repository ? { repository } : {}),
      }
    );
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

/**
 * Connectors of a Git provider the caller may see: every one with the unqualified view scope, otherwise those
 * it holds any Git scope on (connector, group/owner or project/repository qualifiers, through implied view).
 * `full` is false when only narrower grants exist: connector details such as allowlists are then left out.
 */
export function gitConnectorVisibility(
  scopes: readonly string[],
  provider: 'gitlab' | 'github' | 'git'
): (connectorId: string) => { visible: boolean; full: boolean } {
  const viewScope = `integrations:${provider}:view`;
  const granted = gitGrantedConnectorIds(scopes, viewScope);
  return (connectorId) => {
    if (granted.all) return { visible: true, full: true };
    if (!granted.connectorIds.has(connectorId)) return { visible: false, full: false };
    return { visible: true, full: hasGitConnectorScope(scopes, viewScope, connectorId) };
  };
}
