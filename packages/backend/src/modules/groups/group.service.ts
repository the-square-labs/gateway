import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { permissionGroups, userPasskeys, users, userTotpFactors } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasScope, isScopeSubset } from '@/lib/permissions.js';
import { canonicalizeScopes } from '@/lib/scopes.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AISandboxService } from '@/modules/ai/ai.sandbox.service.js';
import {
  computeEffectiveGroupAccess,
  computeEffectiveUserAccess,
  fetchGroupScopeMap,
} from '@/modules/auth/live-session-user.js';
import { mfaRequiredChannel } from '@/modules/auth/mfa-events.js';
import type { CreateGroupInput, UpdateGroupInput } from './group.schemas.js';

const logger = createChildLogger('GroupService');

function disallowedScopes(effectiveScopes: string[], actorScopes: string[]) {
  return effectiveScopes.filter((scope) => !hasScope(actorScopes, scope));
}

function assertNoProtectedSystemScope(effectiveScopes: string[]) {
  if (effectiveScopes.includes('admin:system')) {
    throw new AppError(403, 'SCOPE_NOT_ALLOWED', 'admin:system cannot be assigned to custom groups');
  }
}

@injectable()
export class GroupService {
  constructor(@inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient) {}

  private eventBus?: import('@/services/event-bus.service.js').EventBusService;
  private sandboxService?: AISandboxService;
  setEventBus(bus: import('@/services/event-bus.service.js').EventBusService) {
    this.eventBus = bus;
  }
  setSandboxService(service: AISandboxService) {
    this.sandboxService = service;
  }
  private emitGroup(id: string, action: 'created' | 'updated' | 'deleted') {
    this.eventBus?.publish('group.changed', { id, action });
  }

  private collectDescendantGroupIds(
    groupId: string,
    groupMap: Map<string, { id: string; parentId: string | null }>
  ): string[] {
    const descendants: string[] = [];
    const queue = [groupId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const group of groupMap.values()) {
        if (group.parentId !== current) continue;
        descendants.push(group.id);
        queue.push(group.id);
      }
    }

    return descendants;
  }

  /** Cascade a permissions change to every user in the affected group tree. */
  private async cascadePermissions(groupId: string) {
    const groupMap = await fetchGroupScopeMap(this.db);
    const affectedGroupIds = [groupId, ...this.collectDescendantGroupIds(groupId, groupMap)];

    const affected = await this.db
      .select({
        id: users.id,
        groupId: users.groupId,
        additionalScopes: users.additionalScopes,
        isBlocked: users.isBlocked,
      })
      .from(users)
      .where(and(inArray(users.groupId, affectedGroupIds), isNull(users.deletedAt)));

    for (const u of affected) {
      const scopes = u.isBlocked ? [] : computeEffectiveUserAccess(u.groupId, groupMap, u.additionalScopes).scopes;
      this.eventBus?.publish(`permissions.changed.${u.id}`, { scopes, groupId: u.groupId });
      await this.sandboxService?.revokeUserAccess(u.id, scopes, 'permissions_changed').catch((error) => {
        logger.warn('Failed to revoke sandbox jobs after group permission cascade', { userId: u.id, groupId, error });
      });
    }
  }

  /** Notify only local accounts that still need to enroll an MFA factor. */
  private async notifyMfaPolicyChanged(
    groupId: string,
    groupName: string,
    requireGateway2fa: boolean
  ): Promise<{ memberCount: number }> {
    const members = await this.db
      .select({ id: users.id, authMethod: users.authMethod })
      .from(users)
      .where(and(eq(users.groupId, groupId), isNull(users.deletedAt)));
    const localUserIds = members.filter((member) => member.authMethod !== 'oidc').map((member) => member.id);
    if (localUserIds.length === 0) return { memberCount: members.length };

    const [totpFactors, passkeys] = await Promise.all([
      this.db
        .select({ userId: userTotpFactors.userId })
        .from(userTotpFactors)
        .where(inArray(userTotpFactors.userId, localUserIds)),
      this.db
        .select({ userId: userPasskeys.userId })
        .from(userPasskeys)
        .where(inArray(userPasskeys.userId, localUserIds)),
    ]);
    const configuredUserIds = new Set([...totpFactors, ...passkeys].map((factor) => factor.userId));
    const affectedUserIds = localUserIds.filter((userId) => !configuredUserIds.has(userId));
    for (const userId of affectedUserIds) {
      this.eventBus?.publish(mfaRequiredChannel(userId), {
        groupId,
        groupName,
        requireGateway2fa,
      });
    }
    return { memberCount: members.length };
  }

  async getEffectiveScopesForGroupId(groupId: string): Promise<string[]> {
    const groupMap = await fetchGroupScopeMap(this.db);
    return computeEffectiveGroupAccess(groupId, groupMap).scopes;
  }

  async buildEffectiveScopes(scopes: string[], parentId: string | null | undefined): Promise<string[]> {
    const directScopes = canonicalizeScopes(scopes);
    if (!parentId) return directScopes;

    const parentScopes = await this.getEffectiveScopesForGroupId(parentId);
    return canonicalizeScopes([...directScopes, ...parentScopes]);
  }

  async assertCanCreateGroup(input: CreateGroupInput, actorScopes: string[]): Promise<void> {
    const effectiveScopes = await this.buildEffectiveScopes(input.scopes, input.parentId);
    assertNoProtectedSystemScope(effectiveScopes);
    if (!isScopeSubset(effectiveScopes, actorScopes)) {
      throw new AppError(
        403,
        'SCOPE_NOT_ALLOWED',
        `Cannot grant scopes you do not possess: ${disallowedScopes(effectiveScopes, actorScopes).join(', ')}`
      );
    }
  }

  async assertCanUpdateGroup(id: string, input: UpdateGroupInput, actorScopes: string[]): Promise<void> {
    const existingGroup = await this.getGroup(id);
    if (existingGroup.isBuiltin) {
      const nonSecurityChanges =
        input.name !== undefined ||
        input.description !== undefined ||
        input.scopes !== undefined ||
        input.parentId !== undefined;
      if (nonSecurityChanges || input.requireGateway2fa === undefined || !actorScopes.includes('admin:system')) {
        throw new AppError(
          403,
          'BUILTIN_GROUP',
          'Only system administrators can update MFA policy on a built-in group'
        );
      }
      return;
    }

    if (input.scopes === undefined && input.parentId === undefined) return;

    const nextScopes = input.scopes ?? existingGroup.scopes;
    const nextParentId = input.parentId !== undefined ? input.parentId : existingGroup.parentId;
    const effectiveScopes = await this.buildEffectiveScopes(nextScopes, nextParentId);
    assertNoProtectedSystemScope(effectiveScopes);

    if (!isScopeSubset(effectiveScopes, actorScopes)) {
      throw new AppError(
        403,
        'SCOPE_NOT_ALLOWED',
        `Cannot grant scopes you do not possess: ${disallowedScopes(effectiveScopes, actorScopes).join(', ')}`
      );
    }
  }

  async assertCanDeleteGroup(id: string, actorScopes: string[]): Promise<void> {
    const groupMap = await fetchGroupScopeMap(this.db);
    if (!groupMap.has(id)) {
      throw new AppError(404, 'GROUP_NOT_FOUND', 'Permission group not found');
    }

    const affectedGroupIds = [id, ...this.collectDescendantGroupIds(id, groupMap)];
    const affectedScopes = [
      ...new Set(affectedGroupIds.flatMap((groupId) => computeEffectiveGroupAccess(groupId, groupMap).scopes)),
    ];

    if (!isScopeSubset(affectedScopes, actorScopes)) {
      throw new AppError(
        403,
        'SCOPE_NOT_ALLOWED',
        `Cannot delete a group that affects scopes you do not possess: ${disallowedScopes(affectedScopes, actorScopes).join(', ')}`
      );
    }
  }

  async listGroups() {
    const groups = await this.db
      .select({
        id: permissionGroups.id,
        name: permissionGroups.name,
        description: permissionGroups.description,
        isBuiltin: permissionGroups.isBuiltin,
        parentId: permissionGroups.parentId,
        folderId: permissionGroups.folderId,
        sortOrder: permissionGroups.sortOrder,
        scopes: permissionGroups.scopes,
        requireGateway2fa: permissionGroups.requireGateway2fa,
        createdAt: permissionGroups.createdAt,
        updatedAt: permissionGroups.updatedAt,
        memberCount: sql<number>`(SELECT count(*) FROM users WHERE users.group_id = "permission_groups"."id" AND users.deleted_at IS NULL)::int`,
      })
      .from(permissionGroups)
      .orderBy(
        sql`${permissionGroups.isBuiltin} DESC`,
        sql`${permissionGroups.sortOrder} ASC`,
        sql`jsonb_array_length(${permissionGroups.scopes}) DESC`
      );

    // Build a map for inherited scope computation
    const groupMap = new Map(groups.map((g) => [g.id, g]));

    return groups.map((g) => ({
      ...g,
      inheritedScopes: this.computeInheritedScopes(g.id, groupMap),
      createdAt: g.createdAt.toISOString(),
      updatedAt: g.updatedAt.toISOString(),
    }));
  }

  async getGroup(id: string) {
    const group = await this.db.query.permissionGroups.findFirst({
      where: eq(permissionGroups.id, id),
    });

    if (!group) {
      throw new AppError(404, 'GROUP_NOT_FOUND', 'Permission group not found');
    }

    const [{ count: memberCount }] = await this.db
      .select({ count: count() })
      .from(users)
      .where(and(eq(users.groupId, id), isNull(users.deletedAt)));

    // Fetch all groups for inherited scope computation
    const allGroups = await this.db.select().from(permissionGroups);
    const groupMap = new Map(allGroups.map((g) => [g.id, g]));

    return {
      ...group,
      memberCount: Number(memberCount),
      inheritedScopes: this.computeInheritedScopes(group.id, groupMap),
      createdAt: group.createdAt.toISOString(),
      updatedAt: group.updatedAt.toISOString(),
    };
  }

  async getGroupByName(name: string) {
    return this.db.query.permissionGroups.findFirst({
      where: eq(permissionGroups.name, name),
    });
  }

  async createGroup(input: CreateGroupInput) {
    const scopes = canonicalizeScopes(input.scopes);
    const existing = await this.getGroupByName(input.name);
    if (existing) {
      throw new AppError(409, 'GROUP_EXISTS', `Group "${input.name}" already exists`);
    }

    if (input.parentId) {
      const parent = await this.db.query.permissionGroups.findFirst({
        where: eq(permissionGroups.id, input.parentId),
      });
      if (!parent) {
        throw new AppError(404, 'PARENT_NOT_FOUND', 'Parent group not found');
      }
      if (parent.parentId) {
        throw new AppError(
          400,
          'NESTING_TOO_DEEP',
          'Groups can only be nested one level deep — the parent group is already a child of another group'
        );
      }
    }

    const [group] = await this.db
      .insert(permissionGroups)
      .values({
        name: input.name,
        description: input.description ?? null,
        isBuiltin: false,
        parentId: input.parentId ?? null,
        scopes,
        requireGateway2fa: input.requireGateway2fa ?? false,
      })
      .returning();

    logger.info('Created permission group', { groupId: group.id, name: group.name, parentId: group.parentId });
    this.emitGroup(group.id, 'created');
    if (group.requireGateway2fa) {
      this.eventBus?.publish('group.mfa.required', {
        groupId: group.id,
        groupName: group.name,
        requireGateway2fa: true,
        memberCount: 0,
      });
    }

    return {
      ...group,
      inheritedScopes: [] as string[],
      memberCount: 0,
      createdAt: group.createdAt.toISOString(),
      updatedAt: group.updatedAt.toISOString(),
    };
  }

  async updateGroup(id: string, input: UpdateGroupInput) {
    const group = await this.db.query.permissionGroups.findFirst({
      where: eq(permissionGroups.id, id),
    });

    if (!group) {
      throw new AppError(404, 'GROUP_NOT_FOUND', 'Permission group not found');
    }

    const builtinMfaOnly =
      group.isBuiltin &&
      input.requireGateway2fa !== undefined &&
      input.name === undefined &&
      input.description === undefined &&
      input.scopes === undefined &&
      input.parentId === undefined;
    if (group.isBuiltin && !builtinMfaOnly) {
      throw new AppError(403, 'BUILTIN_GROUP', 'Cannot modify a built-in group');
    }

    if (input.name) {
      const existing = await this.getGroupByName(input.name);
      if (existing && existing.id !== id) {
        throw new AppError(409, 'GROUP_EXISTS', `Group "${input.name}" already exists`);
      }
    }

    // Validate parentId doesn't create a cycle or exceed nesting depth
    if (input.parentId !== undefined) {
      if (input.parentId === id) {
        throw new AppError(400, 'CYCLE_DETECTED', 'A group cannot be its own parent');
      }
      if (input.parentId) {
        const allGroups = await this.db.select().from(permissionGroups);
        const groupMap = new Map(allGroups.map((g) => [g.id, g]));

        // Only allow nesting under top-level groups
        const parent = groupMap.get(input.parentId);
        if (parent?.parentId) {
          throw new AppError(
            400,
            'NESTING_TOO_DEEP',
            'Groups can only be nested one level deep — the parent group is already a child of another group'
          );
        }

        // A group with children cannot become a child itself
        const hasChildren = allGroups.some((g) => g.parentId === id);
        if (hasChildren) {
          throw new AppError(
            400,
            'NESTING_TOO_DEEP',
            'This group has child groups — it cannot be nested under another group'
          );
        }

        // Walk up from proposed parent to check for cycles
        let current: string | null = input.parentId;
        const visited = new Set<string>([id]);
        while (current) {
          if (visited.has(current)) {
            throw new AppError(400, 'CYCLE_DETECTED', 'This parent assignment would create a cycle');
          }
          visited.add(current);
          current = groupMap.get(current)?.parentId ?? null;
        }
      }
    }

    const [updated] = await this.db
      .update(permissionGroups)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.scopes !== undefined && { scopes: canonicalizeScopes(input.scopes) }),
        ...(input.parentId !== undefined && { parentId: input.parentId }),
        ...(input.requireGateway2fa !== undefined && { requireGateway2fa: input.requireGateway2fa }),
        updatedAt: new Date(),
      })
      .where(eq(permissionGroups.id, id))
      .returning();

    logger.info('Updated permission group', { groupId: id, name: updated.name });
    this.emitGroup(id, 'updated');
    if (input.requireGateway2fa !== undefined && input.requireGateway2fa !== group.requireGateway2fa) {
      const { memberCount } = await this.notifyMfaPolicyChanged(updated.id, updated.name, input.requireGateway2fa);
      this.eventBus?.publish('group.mfa.required', {
        groupId: updated.id,
        groupName: updated.name,
        requireGateway2fa: input.requireGateway2fa,
        memberCount,
      });
    }
    if (input.scopes !== undefined || input.parentId !== undefined) {
      await this.cascadePermissions(id);
    }

    return {
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  async deleteGroup(id: string) {
    const group = await this.db.query.permissionGroups.findFirst({
      where: eq(permissionGroups.id, id),
    });

    if (!group) {
      throw new AppError(404, 'GROUP_NOT_FOUND', 'Permission group not found');
    }

    if (group.isBuiltin) {
      throw new AppError(403, 'BUILTIN_GROUP', 'Cannot delete a built-in group');
    }

    const [{ count: memberCount }] = await this.db
      .select({ count: count() })
      .from(users)
      .where(and(eq(users.groupId, id), isNull(users.deletedAt)));

    if (Number(memberCount) > 0) {
      throw new AppError(
        409,
        'GROUP_HAS_MEMBERS',
        `Cannot delete group with ${memberCount} assigned user(s). Reassign them first.`
      );
    }

    // Unparent child groups before deleting
    const childGroupIds = (
      await this.db.select({ id: permissionGroups.id }).from(permissionGroups).where(eq(permissionGroups.parentId, id))
    ).map((group) => group.id);
    await this.db.update(permissionGroups).set({ parentId: null }).where(eq(permissionGroups.parentId, id));

    await this.db.delete(permissionGroups).where(eq(permissionGroups.id, id));
    logger.info('Deleted permission group', { groupId: id, name: group.name });
    this.emitGroup(id, 'deleted');

    for (const childGroupId of childGroupIds) {
      await this.cascadePermissions(childGroupId);
    }
  }

  async getMemberIds(groupId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.groupId, groupId), isNull(users.deletedAt)));
    return rows.map((r) => r.id);
  }

  /**
   * Compute inherited scopes by walking the parent chain.
   * Returns scopes from all ancestors (deduped), NOT including the group's own scopes.
   */
  private computeInheritedScopes(
    groupId: string,
    groupMap: Map<string, { id: string; parentId: string | null; scopes: unknown }>
  ): string[] {
    const inherited = new Set<string>();
    const group = groupMap.get(groupId);
    if (!group) return [];

    let current = group.parentId ? groupMap.get(group.parentId) : null;
    const visited = new Set<string>([groupId]);
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      const parentScopes = (current.scopes as string[]) ?? [];
      for (const s of parentScopes) inherited.add(s);
      current = current.parentId ? groupMap.get(current.parentId) : null;
    }

    return [...inherited];
  }
}
