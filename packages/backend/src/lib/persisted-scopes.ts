import { eq, or, type SQL, sql } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import {
  apiTokens,
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthRefreshTokens,
  permissionGroups,
  users,
} from '@/db/schema/index.js';

/** Users and permission groups whose stored scopes changed, so their sessions can be told. */
export interface PersistedScopeChanges {
  userIds: string[];
  groupIds: string[];
}

// Every stored grant: user and group permissions, API tokens and every OAuth/MCP credential stage.
const scopeTables = (): Array<{ table: any; columns: Record<string, any>; touch?: boolean }> => [
  { table: permissionGroups, columns: { scopes: permissionGroups.scopes }, touch: true },
  { table: users, columns: { additionalScopes: users.additionalScopes }, touch: true },
  { table: apiTokens, columns: { scopes: apiTokens.scopes } },
  {
    table: oauthAuthorizationCodes,
    columns: { scopes: oauthAuthorizationCodes.scopes, requestedScopes: oauthAuthorizationCodes.requestedScopes },
  },
  { table: oauthRefreshTokens, columns: { scopes: oauthRefreshTokens.scopes } },
  { table: oauthAccessTokens, columns: { scopes: oauthAccessTokens.scopes } },
];

/** The distinct stored scopes whose qualifier contains a UUID, the only ones that can name a resource row. */
export async function listPersistedQualifiedScopes(tx: DrizzleExecutor): Promise<string[]> {
  const stored = sql.join(
    scopeTables().flatMap(({ table, columns }) =>
      Object.values(columns).map((column) => sql`select jsonb_array_elements_text(${column}) as scope from ${table}`)
    ),
    sql` union `
  );
  const result = await tx.execute<{ scope: string }>(
    sql`select scope from (${stored}) as stored where scope ~ ':.*[0-9a-f]{8}-[0-9a-f]{4}-'`
  );
  return result.rows.map((row) => row.scope);
}

function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

/**
 * Rewrite every stored scope list that contains one of `candidates` (the exact scopes `rewrite` may change). Rows are
 * locked while they are rewritten, so a concurrent grant is never overwritten with a stale list.
 */
export async function rewritePersistedScopes(
  tx: DrizzleExecutor,
  candidates: readonly string[],
  rewrite: (scopes: readonly string[]) => string[]
): Promise<PersistedScopeChanges> {
  if (candidates.length === 0) return { userIds: [], groupIds: [] };
  const candidateArray = textArray(candidates);
  return rewriteMatchingScopes(tx, (column) => sql`jsonb_exists_any(${column}, ${candidateArray})`, rewrite);
}

/**
 * Rewrite every stored scope list holding one of `bases`, bare or with any qualifier (`<base>:<suffix>`). Rows are
 * locked while they are rewritten, like `rewritePersistedScopes`.
 */
export async function rewritePersistedScopesNaming(
  tx: DrizzleExecutor,
  bases: readonly string[],
  rewrite: (scopes: readonly string[]) => string[]
): Promise<PersistedScopeChanges> {
  if (bases.length === 0) return { userIds: [], groupIds: [] };
  const baseArray = textArray(bases);
  return rewriteMatchingScopes(
    tx,
    (column) =>
      sql`exists (select 1 from jsonb_array_elements_text(${column}) as stored(scope), unnest(${baseArray}) as named(base)
        where stored.scope = named.base or starts_with(stored.scope, named.base || ':'))`,
    rewrite
  );
}

function textArray(values: readonly string[]): SQL {
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `
  )}]::text[]`;
}

async function rewriteMatchingScopes(
  tx: DrizzleExecutor,
  matches: (column: any) => SQL,
  rewrite: (scopes: readonly string[]) => string[]
): Promise<PersistedScopeChanges> {
  const changes: PersistedScopeChanges = { userIds: [], groupIds: [] };
  for (const { table, columns, touch } of scopeTables()) {
    const keys = Object.keys(columns);
    const rows: Array<Record<string, any>> = await (tx as any)
      .select({ id: table.id, ...columns })
      .from(table)
      .where(or(...keys.map((key) => matches(columns[key]))))
      // One lock order, so two deletions that touch the same grants cannot deadlock.
      .orderBy(table.id)
      .for('update');
    for (const row of rows) {
      const next = Object.fromEntries(keys.map((key) => [key, rewrite(row[key])]));
      if (keys.every((key) => sameScopes(next[key], row[key]))) continue;
      await (tx as any)
        .update(table)
        .set(touch ? { ...next, updatedAt: new Date() } : next)
        .where(eq(table.id, row.id));
      if (table === users) changes.userIds.push(row.id);
      if (table === permissionGroups) changes.groupIds.push(row.id);
    }
  }
  return changes;
}
