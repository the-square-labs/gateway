import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { HostingAction, HostingSettings } from './hosting-provider.types.js';

export function assertHostingScope(scopes: string[], scope: string, id?: string): void {
  if (!hasScope(scopes, id ? `${scope}:${id}` : scope)) {
    throw new AppError(403, 'HOSTING_ACCESS_DENIED', 'You do not have access to this hosting operation');
  }
}

export function canViewHostingFinance(scopes: string[], connectorId: string): boolean {
  return hasScope(scopes, `hosting:billing:view:${connectorId}`);
}

export function hostingActionScope(action: HostingAction): string {
  if (action === 'delete') return 'hosting:resources:delete';
  if (action === 'resize') return 'hosting:resources:resize';
  if (action === 'recover') return 'hosting:resources:recover';
  return 'hosting:resources:power';
}

/** Check every hosted role before returning any affected node names or dispatching the action. */
export function assertHostingResourceAction(
  scopes: string[],
  resourceId: string,
  action: HostingAction,
  nodeIds: string[]
): void {
  assertHostingScope(scopes, hostingActionScope(action), resourceId);
  for (const nodeId of nodeIds) {
    assertHostingScope(scopes, 'nodes:details', nodeId);
    assertHostingScope(scopes, action === 'delete' ? 'nodes:delete' : 'nodes:config:edit', nodeId);
  }
}

export function assertHostingAdoptionAuthority(scopes: string[], settings: HostingSettings): void {
  if (!settings.adoptionEnabled) return;
  if (settings.adoptionNodeIds.length === 0) {
    assertHostingScope(scopes, 'nodes:config:edit');
    assertHostingScope(scopes, 'nodes:details');
  } else {
    for (const nodeId of settings.adoptionNodeIds) {
      assertHostingScope(scopes, 'nodes:config:edit', nodeId);
      assertHostingScope(scopes, 'nodes:details', nodeId);
    }
  }
}
