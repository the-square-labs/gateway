import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function readMigrationJournal(): JournalEntry[] {
  const raw = readFileSync(join(process.cwd(), 'src/db/migrations/meta/_journal.json'), 'utf8');
  const parsed = JSON.parse(raw) as { entries: JournalEntry[] };
  return parsed.entries;
}

describe('drizzle migration metadata', () => {
  it('keeps journal entries monotonic and aligned with migration files', () => {
    const entries = readMigrationJournal();
    const journalTags = new Set(entries.map((entry) => entry.tag));
    const sqlTags = readdirSync(join(process.cwd(), 'src/db/migrations'))
      .filter((file) => file.endsWith('.sql'))
      .map((file) => file.slice(0, -'.sql'.length))
      .sort();
    const snapshotTags = readdirSync(join(process.cwd(), 'src/db/migrations/meta'))
      .filter((file) => file.endsWith('_snapshot.json'))
      .map((file) => file.slice(0, -'_snapshot.json'.length))
      .sort();
    const journalPrefixes = entries.map((entry) => entry.tag.slice(0, 4));

    for (const [index, entry] of entries.entries()) {
      expect(entry.idx).toBe(index);
      expect(existsSync(join(process.cwd(), 'src/db/migrations', `${entry.tag}.sql`))).toBe(true);

      const previous = entries[index - 1];
      if (previous) {
        expect(entry.when).toBeGreaterThan(previous.when);
      }
    }

    expect(sqlTags.filter((tag) => !journalTags.has(tag))).toEqual([]);
    expect(journalPrefixes.filter((tag) => !snapshotTags.includes(tag))).toEqual([]);
    expect(snapshotTags.filter((tag) => !journalPrefixes.includes(tag))).toEqual([]);
    expect(snapshotTags.at(-1)).toBe(entries.at(-1)?.tag.slice(0, 4));
  });

  it('keeps the AI search payload purge scoped to unsafe derived documents', () => {
    const migration = readFileSync(
      join(process.cwd(), 'src/db/migrations/0053_ai_search_tool_payload_reset.sql'),
      'utf8'
    );

    expect(migration).toContain('"kind" IN');
    expect(migration).toContain("'tool_call'");
    expect(migration).toContain("'tool_result'");
    expect(migration).toContain("'window'");
    expect(migration).toContain('"role" = \'tool\'');
    expect(migration).not.toMatch(/DELETE FROM "ai_conversation_search_documents"\s*;$/m);
  });

  it('backfills the ordered node service address list from the legacy columns', () => {
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0145_perpetual_firebrand.sql'), 'utf8');

    expect(migration).toContain('ADD COLUMN "service_addresses" text[] DEFAULT \'{}\' NOT NULL');
    expect(migration).toContain('ARRAY_REMOVE(ARRAY["service_address", "secondary_service_address"], NULL)');
  });

  it('backfills resource slugs deterministically before enforcing constraints', () => {
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0056_strange_yellowjacket.sql'), 'utf8');

    expect(migration.match(/ORDER BY "created_at", "id"/g)).toHaveLength(3);
    expect(migration).toContain('"gateway_slug_transliterate"');
    expect(migration).toContain('"gateway_slug_base"');
    expect(migration).toContain('"gateway_slug_candidate"');
    expect(migration).toContain("WHEN \"base_value\" IN ('file', 'console') THEN 1");
    expect(migration).toContain('WHEN "base_value" = \'new\' THEN 1');

    for (const [table, constraint] of [
      ['nodes', 'nodes_slug_unique'],
      ['database_connections', 'database_connections_slug_unique'],
      ['proxy_hosts', 'proxy_hosts_slug_unique'],
    ]) {
      expect(migration).toContain(`ALTER TABLE "${table}" ALTER COLUMN "slug" SET NOT NULL`);
      expect(migration).toContain(`ADD CONSTRAINT "${constraint}" UNIQUE("slug")`);
    }

    expect(migration).not.toContain('ALTER TABLE "logging_environments"');
    expect(migration).not.toContain('ALTER TABLE "logging_schemas"');
  });

  it('creates encrypted inference credentials and an append-only usage ledger', () => {
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0064_glossy_celestials.sql'), 'utf8');

    expect(migration).toContain('"encrypted_payload" text NOT NULL');
    expect(migration).toContain('"encrypted_dek" text NOT NULL');
    expect(migration).not.toContain('"access_token"');
    expect(migration).not.toContain('"refresh_token"');
    expect(migration).toContain('gateway_reject_inference_usage_ledger_mutation');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "inference_usage_ledger"');
  });

  it('keeps one active package-managed token per harness installation', () => {
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0071_new_zodiak.sql'), 'utf8');

    expect(migration).toContain('"managed_by" varchar(64)');
    expect(migration).toContain('"installation_id" uuid');
    expect(migration).toContain('"inference_tokens_managed_identity_active_unique"');
    expect(migration).toContain('"revoked_at" is null');
  });

  it('refreshes GPT-5.6 provider prices with the complete long-context tier', () => {
    const migration = readFileSync(
      join(process.cwd(), 'src/db/migrations/0092_refresh_openai_gpt_5_6_pricing.sql'),
      'utf8'
    );

    expect(migration).toContain("'openai-api-2026-08-06'");
    expect(migration).toContain("WHEN 'gpt-5.6-terra' THEN 2000000");
    expect(migration).toContain("WHEN 'gpt-5.6-luna' THEN 200000");
    expect(migration).toContain("'long_context_threshold_tokens', 272000");
    expect(migration).toContain("'long_context_input_microdollars_per_million'");
    expect(migration).toContain('"snapshots"."source" = \'manual\'');
    expect(migration).toContain('ON CONFLICT ("source_id", "version") DO NOTHING');
  });

  it('removes the legacy relay database authorization surface', () => {
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0099_slow_karnak.sql'), 'utf8');

    expect(migration).toContain('DROP VIEW IF EXISTS "public"."gateway_relay_node_identities_v1"');
    expect(migration).toContain('DROP VIEW IF EXISTS "public"."gateway_relay_managed_databases_v1"');
    expect(migration).toContain('DROP VIEW IF EXISTS "public"."gateway_relay_bindings_v1"');
    expect(migration).toContain('DROP OWNED BY gateway_relay');
    expect(migration).toContain('DROP ROLE gateway_relay');
  });

  it('collapses existing inference token grants into the manage permission', () => {
    const migration = readFileSync(
      join(process.cwd(), 'src/db/migrations/0078_collapse_inference_token_permissions.sql'),
      'utf8'
    );

    expect(migration).toContain("THEN 'inference:tokens:manage'");
    expect(migration).toContain('UPDATE "permission_groups"');
    expect(migration).toContain('UPDATE "users"');
    expect(migration).toContain('UPDATE "api_tokens"');
    expect(migration).toContain('UPDATE "oauth_authorization_codes"');
    expect(migration).toContain('UPDATE "ai_run_tool_calls"');
    expect(migration).toContain('UPDATE "sandbox_jobs"');
  });

  it('migrates inference use and personal usage grants into the canonical AI permission', () => {
    const migration = readFileSync(
      join(process.cwd(), 'src/db/migrations/0114_collapse_inference_use_into_ai.sql'),
      'utf8'
    );

    expect(migration).toContain("WHEN entry.value IN ('inference:use', 'inference:usage:view:self')");
    expect(migration).toContain("THEN 'feat:ai:use'");
    expect(migration).toContain('UPDATE "permission_groups"');
    expect(migration).toContain('UPDATE "users"');
    expect(migration).toContain('UPDATE "api_tokens"');
    expect(migration).toContain('UPDATE "oauth_authorization_codes"');
    expect(migration).toContain('UPDATE "oauth_refresh_tokens"');
    expect(migration).toContain('UPDATE "oauth_access_tokens"');
    expect(migration).toContain('UPDATE "ai_run_tool_calls"');
    expect(migration).toContain('UPDATE "sandbox_jobs"');
    expect(migration).toContain("COALESCE(\"scopes\", '[]'::jsonb) - 'inference:use' - 'inference:usage:view:self'");
  });

  it('collapses GitLab registry-view grants into the canonical Docker registry permission', () => {
    const migration = readFileSync(
      join(process.cwd(), 'src/db/migrations/0126_collapse_gitlab_registry_view.sql'),
      'utf8'
    );

    expect(migration).toContain("WHEN entry.value = 'integrations:gitlab:registry:view'");
    expect(migration).toContain("THEN 'docker:registries:view'");
    expect(migration).toContain('UPDATE "permission_groups"');
    expect(migration).toContain('UPDATE "users"');
    expect(migration).toContain('UPDATE "api_tokens"');
    expect(migration).toContain('UPDATE "oauth_authorization_codes"');
    expect(migration).toContain('UPDATE "oauth_refresh_tokens"');
    expect(migration).toContain('UPDATE "oauth_access_tokens"');
    expect(migration).toContain('UPDATE "ai_run_tool_calls"');
    expect(migration).toContain('UPDATE "sandbox_jobs"');
  });

  it('removes the OAuth-only inference setup scope from user assignments', () => {
    const migration = readFileSync(
      join(process.cwd(), 'src/db/migrations/0154_remove_inference_setup_assignments.sql'),
      'utf8'
    );

    expect(migration).toContain('UPDATE "permission_groups"');
    expect(migration).toContain('UPDATE "users"');
    expect(migration).toContain("scope_value <> 'inference:setup'");
    expect(migration).not.toContain('UPDATE "oauth_access_tokens"');
    expect(migration).not.toContain('UPDATE "oauth_refresh_tokens"');
  });

  it('preserves the published 0155 migration before creating Compose tables and proxy bindings', () => {
    const entries = readMigrationJournal();
    const publishedScopeMigration = entries.findIndex((entry) => entry.tag === '0155_split_ai_workspace_access');
    const composeTables = entries.findIndex((entry) => entry.tag === '0156_organic_microbe');
    const composeProxyBindings = entries.findIndex((entry) => entry.tag === '0157_blue_network');

    expect(publishedScopeMigration).toBeGreaterThanOrEqual(0);
    expect(composeTables).toBe(publishedScopeMigration + 1);
    expect(composeProxyBindings).toBe(composeTables + 1);

    const composeMigration = readFileSync(join(process.cwd(), 'src/db/migrations/0156_organic_microbe.sql'), 'utf8');
    const proxyMigration = readFileSync(join(process.cwd(), 'src/db/migrations/0157_blue_network.sql'), 'utf8');
    expect(composeMigration).toContain('CREATE TABLE "docker_compose_projects"');
    expect(proxyMigration).toContain('REFERENCES "public"."docker_compose_projects"');
  });
  it('preserves existing AI Workspace grants when splitting inference access', () => {
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0155_split_ai_workspace_access.sql'), 'utf8');

    expect(migration).toContain('UPDATE "permission_groups"');
    expect(migration).toContain('UPDATE "users"');
    expect(migration).toContain("'feat:ai:use'");
    expect(migration).toContain("'ai:workspace:use'");
    expect(migration).not.toContain('UPDATE "api_tokens"');
  });

  it('adds the inference core runtime tables without touching existing inference rows', () => {
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0139_inference_core_runtime.sql'), 'utf8');

    expect(migration).toContain('CREATE TABLE "inference_core_state"');
    expect(migration).toContain('CREATE TABLE "inference_core_operations"');
    expect(migration).toContain('CONSTRAINT "inference_core_state_singleton" CHECK');
    expect(migration).toContain('"inference_core_operations_running_unique"');
    expect(migration).toContain('ADD COLUMN "core_account_id" text');
    expect(migration).toContain('ADD COLUMN "core_model_id" text');
    expect(migration).toContain('ADD COLUMN "core_attempt_id" text');
    expect(migration).toContain('ADD COLUMN "parent_core_attempt_id" text');
    expect(migration).toContain('"inference_attempts_core_attempt_unique"');

    // Purely additive: no destructive or rewriting operation against the
    // existing inference tables or the immutable usage ledger.
    expect(migration).not.toMatch(/DROP TABLE/i);
    expect(migration).not.toMatch(/ALTER TABLE "inference_(requests|usage_ledger|quota_snapshots)"/i);
    expect(migration).not.toMatch(/ALTER COLUMN .* (DROP|SET) NOT NULL/i);
    expect(migration).not.toMatch(/DELETE FROM|UPDATE "inference_/i);
  });

  it('preserves a custom guest group before reserving the built-in name', () => {
    const migration = readFileSync(
      join(process.cwd(), 'src/db/migrations/0115_reserve_guest_builtin_group.sql'),
      'utf8'
    );

    expect(migration).toContain('\'guest-custom-\' || "id"::text');
    expect(migration).toContain('WHERE "name" = \'guest\' AND "is_builtin" = false');
    expect(migration).not.toContain('DELETE FROM "permission_groups"');
  });
});
