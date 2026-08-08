import { eq } from 'drizzle-orm';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { users } from '@/db/schema/index.js';
import { canonicalizeScopes } from '@/lib/scopes.js';
import { SessionService } from '@/services/session.service.js';
import type { User } from '@/types.js';

export interface GroupScopeRecord {
  id: string;
  parentId: string | null;
  scopes: unknown;
  name?: string | null;
  requireGateway2fa?: boolean;
}

export function computeEffectiveGroupAccess(groupId: string, groupMap: Map<string, GroupScopeRecord>) {
  const group = groupMap.get(groupId);
  const scopeSet = new Set<string>();

  if (group) {
    for (const scope of (group.scopes as string[]) ?? []) scopeSet.add(scope);

    const visited = new Set<string>([group.id]);
    let parent = group.parentId ? groupMap.get(group.parentId) : undefined;
    while (parent && !visited.has(parent.id)) {
      visited.add(parent.id);
      for (const scope of (parent.scopes as string[]) ?? []) scopeSet.add(scope);
      parent = parent.parentId ? groupMap.get(parent.parentId) : undefined;
    }
  }

  return {
    groupName: group?.name ?? 'unknown',
    scopes: canonicalizeScopes([...scopeSet]),
  };
}

export function computeEffectiveUserAccess(
  groupId: string,
  groupMap: Map<string, GroupScopeRecord>,
  additionalScopes: unknown
) {
  const groupAccess = computeEffectiveGroupAccess(groupId, groupMap);
  const normalizedAdditionalScopes = canonicalizeScopes(
    Array.isArray(additionalScopes)
      ? additionalScopes.filter((scope): scope is string => typeof scope === 'string')
      : []
  );

  return {
    groupName: groupAccess.groupName,
    groupScopes: groupAccess.scopes,
    additionalScopes: normalizedAdditionalScopes,
    scopes: canonicalizeScopes([...groupAccess.scopes, ...normalizedAdditionalScopes]),
  };
}

export async function fetchGroupScopeMap(db: DrizzleClient): Promise<Map<string, GroupScopeRecord>> {
  const allGroups = await db.query.permissionGroups.findMany({
    columns: { id: true, parentId: true, scopes: true, name: true, requireGateway2fa: true },
  });
  return new Map(allGroups.map((group) => [group.id, group]));
}

export async function resolveEffectiveGroupAccess(db: DrizzleClient, groupId: string) {
  const groupMap = await fetchGroupScopeMap(db);
  return computeEffectiveGroupAccess(groupId, groupMap);
}

export async function resolveEffectiveUserAccess(db: DrizzleClient, groupId: string, additionalScopes: unknown) {
  const groupMap = await fetchGroupScopeMap(db);
  return computeEffectiveUserAccess(groupId, groupMap, additionalScopes);
}

export async function resolveLiveUser(db: DrizzleClient, userId: string): Promise<User | null> {
  const dbUser = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  if (!dbUser) return null;

  const groupMap = await fetchGroupScopeMap(db);
  const { groupName, groupScopes, additionalScopes, scopes } = computeEffectiveUserAccess(
    dbUser.groupId,
    groupMap,
    dbUser.additionalScopes
  );
  return {
    id: dbUser.id,
    oidcSubject: dbUser.oidcSubject,
    authMethod: dbUser.authMethod,
    email: dbUser.email,
    name: dbUser.name,
    avatarUrl: dbUser.avatarUrl,
    groupId: dbUser.groupId,
    groupName,
    requireGateway2fa: Boolean(groupMap.get(dbUser.groupId)?.requireGateway2fa),
    groupScopes,
    additionalScopes,
    scopes: dbUser.deletedAt ? [] : scopes,
    isBlocked: dbUser.isBlocked || Boolean(dbUser.deletedAt),
    isDeleted: Boolean(dbUser.deletedAt),
    aiApprovalMode: dbUser.aiApprovalMode,
  };
}

export async function resolveLiveSessionUser(token: string): Promise<{ user: User; effectiveScopes: string[] } | null> {
  if (!token || token.startsWith('gw_')) return null;

  const sessionService = container.resolve(SessionService);
  const session = await sessionService.getSession(token);
  const sessionUserId = session?.userId ?? session?.user?.id;
  if (!sessionUserId) return null;

  const db = container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
  const user = await resolveLiveUser(db, sessionUserId);
  if (!user) return null;

  return { user, effectiveScopes: user.scopes };
}
