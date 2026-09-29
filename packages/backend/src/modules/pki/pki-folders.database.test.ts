import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { expandFolderScopes } from '@/lib/folder-scopes.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { NginxTemplateFolderService } from '@/modules/proxy/nginx-template-folders.service.js';
import { CAService } from './ca.service.js';
import { CAFolderService, CertificateFolderService, PkiTemplateFolderService } from './pki-folders.service.js';

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;
const audit = { log: async () => true } as unknown as AuditService;

/**
 * Opt-in (GATEWAY_MIGRATION_TEST_DATABASE_URL): CA folders hold whole hierarchies (only roots move, intermediates
 * report and follow their root's folder, folder grants cover the intermediates), system CAs and certificates and
 * built-in templates never move, and deleting a folder ungroups its resources and removes the grants naming it.
 */
describe.skipIf(!url)('PKI and template folders on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  let userId = '';
  let groupId = '';
  let rootId = '';
  let intermediateId = '';
  let leafCaId = '';
  let systemCaId = '';

  const insertCa = async (name: string, parentId: string | null, isSystem = false) =>
    (
      await q(
        `insert into certificate_authorities (type, common_name, key_algorithm, serial_number, encrypted_private_key,
           encrypted_dek, dek_iv, certificate_pem, subject_dn, not_before, not_after, created_by_id, parent_id, is_system)
         values ($1, $2, 'ecdsa-p256', $3, 'key', 'dek', 'iv', 'pem', $4, now(), now() + interval '1 year', $5, $6, $7)
         returning id`,
        [parentId ? 'intermediate' : 'root', name, randomUUID(), `CN=${name}`, userId, parentId, isSystem]
      )
    ).rows[0].id as string;

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'pki_folders');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    const suffix = randomUUID().slice(0, 8);
    groupId = (await q(`insert into permission_groups (name) values ($1) returning id`, [`pki-${suffix}`])).rows[0].id;
    userId = (
      await q(`insert into users (email, name, group_id) values ($1, 'Operator', $2) returning id`, [
        `pki-${suffix}@example.test`,
        groupId,
      ])
    ).rows[0].id;
    rootId = await insertCa(`Root ${suffix}`, null);
    intermediateId = await insertCa(`Services ${suffix}`, rootId);
    leafCaId = await insertCa(`Leaf ${suffix}`, intermediateId);
    systemCaId = await insertCa(`System ${suffix}`, null, true);
  });

  it('moves a whole CA hierarchy with its root and never an intermediate or a system CA', async () => {
    const service = new CAFolderService(db, audit);
    const folder = await service.createFolder({ name: 'Production' }, userId);

    await expect(
      service.moveResourcesToFolder({ ids: [intermediateId], folderId: folder.id }, userId)
    ).rejects.toMatchObject({ statusCode: 400, code: 'PKI_CA_NOT_ROOT' });
    await expect(
      service.moveResourcesToFolder({ ids: [systemCaId], folderId: folder.id }, userId)
    ).rejects.toMatchObject({ statusCode: 409 });

    await service.moveResourcesToFolder({ ids: [rootId], folderId: folder.id }, userId);
    const tree = await new CAService(db, {} as never, audit).getCATree(true);
    const folderOf = (id: string) => tree.find((ca) => ca.id === id)?.folderId;
    expect([folderOf(rootId), folderOf(intermediateId), folderOf(leafCaId)]).toEqual([folder.id, folder.id, folder.id]);
    expect((await new CAService(db, {} as never, audit).getCA(leafCaId)).folderId).toBe(folder.id);
    // Only the root carries the folder; intermediates keep their own sort order under the parent.
    const stored = await q('select id, folder_id from certificate_authorities where id = any($1)', [
      [intermediateId, leafCaId],
    ]);
    expect(stored.rows.every((row) => row.folder_id === null)).toBe(true);

    // A caller granted only an intermediate sees the folder its hierarchy is in.
    const visible = await service.getFolderTree({ allowedResourceIds: [leafCaId], allowedFolderIds: [] });
    expect(visible.map((node) => node.id)).toEqual([folder.id]);

    // A folder grant covers each root in the folder and every intermediate below it.
    const expanded = await expandFolderScopes(db, [`pki:ca:view:folder/${folder.id}`]);
    expect(expanded).toEqual(
      expect.arrayContaining([`pki:ca:view:${rootId}`, `pki:ca:view:${intermediateId}`, `pki:ca:view:${leafCaId}`])
    );
    expect(expanded).not.toContain(`pki:ca:view:${systemCaId}`);
  });

  it('ungroups the hierarchies and removes the grants of a deleted CA folder', async () => {
    const service = new CAFolderService(db, audit);
    const folder = await service.createFolder({ name: 'Partners' }, userId);
    const kept = await new CertificateFolderService(db, audit).createFolder({ name: 'Kept' }, userId);
    await service.moveResourcesToFolder({ ids: [rootId], folderId: folder.id }, userId);
    const grants = [`pki:ca:view:folder/${folder.id}`, `pki:cert:view:folder/${kept.id}`];
    await q('update permission_groups set scopes = $2 where id = $1', [groupId, JSON.stringify(grants)]);

    await service.deleteFolder(folder.id, userId);

    expect((await q('select folder_id from certificate_authorities where id = $1', [rootId])).rows[0].folder_id).toBe(
      null
    );
    expect((await q('select scopes from permission_groups where id = $1', [groupId])).rows[0].scopes).toEqual([
      `pki:cert:view:folder/${kept.id}`,
    ]);
  });

  it('never moves a certificate of a system CA or a built-in template', async () => {
    const certificate = async (caId: string) =>
      (
        await q(
          `insert into certificates (ca_id, type, common_name, serial_number, certificate_pem, key_algorithm, subject_dn,
             issuer_dn, not_before, not_after, issued_by_id)
           values ($1, 'tls-server', 'svc', $2, 'pem', 'ecdsa-p256', 'CN=svc', 'CN=ca', now(), now() + interval '1 day', $3)
           returning id`,
          [caId, randomUUID(), userId]
        )
      ).rows[0].id as string;
    const certificates = new CertificateFolderService(db, audit);
    const certFolder = await certificates.createFolder({ name: 'Mesh' }, userId);
    await expect(
      certificates.moveResourcesToFolder({ ids: [await certificate(systemCaId)], folderId: certFolder.id }, userId)
    ).rejects.toMatchObject({ statusCode: 409 });
    const movable = await certificate(intermediateId);
    await certificates.moveResourcesToFolder({ ids: [movable], folderId: certFolder.id }, userId);
    expect((await q('select folder_id from certificates where id = $1', [movable])).rows[0].folder_id).toBe(
      certFolder.id
    );

    const suffix = randomUUID().slice(0, 8);
    const pkiBuiltin = (
      await q(
        `insert into certificate_templates (name, is_builtin, cert_type, key_usage, ext_key_usage)
         values ($1, true, 'tls-server', '[]', '[]') returning id`,
        [`Builtin ${suffix}`]
      )
    ).rows[0].id;
    const pkiTemplates = new PkiTemplateFolderService(db, audit);
    const pkiFolder = await pkiTemplates.createFolder({ name: 'Services' }, userId);
    await expect(
      pkiTemplates.moveResourcesToFolder({ ids: [pkiBuiltin], folderId: pkiFolder.id }, userId)
    ).rejects.toMatchObject({ statusCode: 400, code: 'BUILTIN_TEMPLATE_FOLDER_LOCKED' });

    const nginxBuiltin = (
      await q(
        `insert into nginx_templates (name, is_builtin, type, content) values ($1, true, 'proxy', '') returning id`,
        [`Builtin ${suffix}`]
      )
    ).rows[0].id;
    await expect(
      new NginxTemplateFolderService(db, audit).reorderResources({ items: [{ id: nginxBuiltin, sortOrder: 0 }] })
    ).rejects.toMatchObject({ statusCode: 400, code: 'BUILTIN_TEMPLATE_FOLDER_LOCKED' });
  });
});
