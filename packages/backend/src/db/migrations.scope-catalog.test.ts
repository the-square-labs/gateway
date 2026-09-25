import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RETIRED_SCOPE_REPLACEMENTS, SCOPE_CLEANUP_MIGRATION_ADDITIONS } from '@/lib/scopes-aliases.js';

const MIGRATION_TAG = '0200_scope_catalog_cleanup';

function readMigration(): string {
  return readFileSync(join(process.cwd(), `src/db/migrations/${MIGRATION_TAG}.sql`), 'utf8');
}

const SCOPE_COLUMNS: Array<[table: string, column: string]> = [
  ['permission_groups', 'scopes'],
  ['users', 'additional_scopes'],
  ['api_tokens', 'scopes'],
  ['oauth_authorization_codes', 'requested_scopes'],
  ['oauth_authorization_codes', 'scopes'],
  ['oauth_refresh_tokens', 'scopes'],
  ['oauth_access_tokens', 'scopes'],
  ['ai_run_tool_calls', 'required_scopes'],
  ['sandbox_jobs', 'required_scopes'],
];

describe('0200 scope catalog cleanup migration', () => {
  it('is journaled at its reserved position', () => {
    const journal = JSON.parse(readFileSync(join(process.cwd(), 'src/db/migrations/meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    expect(journal.entries.find((entry) => entry.tag === MIGRATION_TAG)).toMatchObject({
      idx: 200,
      when: 1790400000000,
    });
  });

  it('rewrites retired names exactly like inbound canonicalization', () => {
    const migration = readMigration();
    for (const [retired, replacements] of Object.entries(RETIRED_SCOPE_REPLACEMENTS)) {
      if (replacements.length === 0) {
        expect(migration, retired).toMatch(new RegExp(`\\('${retired}', NULL(::text)?\\)`));
        continue;
      }
      for (const replacement of replacements) {
        expect(migration, `${retired} -> ${replacement}`).toContain(`('${retired}', '${replacement}')`);
      }
    }
    const rows = [...migration.matchAll(/^\s+\('([^']+)', (?:'([^']+)'|NULL(?:::text)?)\)/gm)];
    const retiredRows = rows.filter(([, from]) => from in RETIRED_SCOPE_REPLACEMENTS);
    const expectedRetiredRows = Object.values(RETIRED_SCOPE_REPLACEMENTS).reduce(
      (count, replacements) => count + Math.max(replacements.length, 1),
      0
    );
    expect(retiredRows).toHaveLength(expectedRetiredRows);
  });

  it('keeps effective access for scopes whose capabilities moved', () => {
    const migration = readMigration();
    for (const [trigger, additions] of Object.entries(SCOPE_CLEANUP_MIGRATION_ADDITIONS)) {
      for (const addition of additions) {
        expect(migration, `${trigger} + ${addition}`).toContain(`('${trigger}', '${addition}')`);
      }
    }
    // Additions are computed from the renamed set (so an old name such as github:sync gets the same
    // additions as manage), keep the trigger's qualifier, and never duplicate a scope the row already
    // holds, so a second run changes nothing.
    expect(migration).toContain(
      'additions.new_scope || substr(renamed.scope, length(additions.trigger_scope) + 1) AS scope'
    );
    expect(migration).toContain(
      "left(renamed.scope, length(additions.trigger_scope) + 1) = additions.trigger_scope || ':'"
    );
    // Folder and node destinations never receive additions.
    expect(migration).toContain("left(substr(renamed.scope, length(additions.trigger_scope) + 2), 7) <> 'folder/'");
    expect(migration).toContain("left(substr(renamed.scope, length(additions.trigger_scope) + 2), 5) <> 'node/'");
    expect(migration).toContain(
      'WHERE NOT EXISTS (SELECT 1 FROM renamed AS existing WHERE existing.scope = added.scope)'
    );
  });

  it('preserves resource, folder, and node qualifiers and matches whole scope segments', () => {
    const migration = readMigration();
    expect(migration).toContain("left(entries.scope, length(candidate.old_scope) + 1) = candidate.old_scope || ':'");
    expect(migration).toContain('retired.new_scope || substr(matched.scope, length(matched.old_scope) + 1)');
    expect(migration).toContain('ORDER BY length(candidate.old_scope) DESC');
    expect(migration).not.toMatch(/LIKE/);
  });

  it('rewrites every stored scope column idempotently and removes its helper', () => {
    const migration = readMigration();
    for (const [table, column] of SCOPE_COLUMNS) {
      expect(migration, `${table}.${column}`).toContain(`UPDATE "${table}"`);
      expect(migration, `${table}.${column}`).toContain(
        `"${column}" IS DISTINCT FROM gateway_scope_catalog_cleanup_0200("${column}")`
      );
    }
    expect(migration).toContain('DROP FUNCTION gateway_scope_catalog_cleanup_0200(jsonb);');
    expect(migration).not.toMatch(/DELETE FROM|DROP TABLE|ALTER TABLE/i);
  });
});
