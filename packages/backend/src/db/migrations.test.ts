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
});
