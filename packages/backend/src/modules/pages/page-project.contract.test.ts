import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { pageProjectEvent } from './page-events.js';
import {
  CreatePageProjectSchema,
  PageProjectListQuerySchema,
  UpdatePageProjectSchema,
} from './page-project.schemas.js';
import { PageProjectService } from './page-project.service.js';
import { canAccessEveryPageProject, visiblePageProjectIds } from './page-project-access.js';
import { PageProjectFolderService } from './page-project-folder.service.js';

describe('Pages Project platform contract', () => {
  it('uses the Page Project ID for every resource-scoped visibility path', () => {
    expect(visiblePageProjectIds(['pages:view'])).toBeUndefined();
    expect(visiblePageProjectIds(['pages:view:project-1', 'pages:edit:project-2'])).toEqual(['project-1', 'project-2']);
    expect(
      canAccessEveryPageProject(['pages:edit:project-1', 'pages:edit:project-2'], 'pages:edit', [
        'project-1',
        'project-2',
      ])
    ).toBe(true);
    expect(canAccessEveryPageProject(['pages:edit:project-1'], 'pages:edit', ['project-1', 'project-2'])).toBe(false);
  });

  it('prunes hidden Page Project folder branches while preserving visible ancestors', async () => {
    const now = new Date();
    const folders = [
      {
        id: 'visible-root',
        name: 'Visible root',
        parentId: null,
        sortOrder: 0,
        depth: 0,
        createdById: 'user-1',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'visible-child',
        name: 'Visible child',
        parentId: 'visible-root',
        sortOrder: 0,
        depth: 1,
        createdById: 'user-1',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'hidden-root',
        name: 'Hidden root',
        parentId: null,
        sortOrder: 1,
        depth: 0,
        createdById: 'user-1',
        createdAt: now,
        updatedAt: now,
      },
    ];
    const select = vi
      .fn()
      .mockReturnValueOnce({ from: () => ({ orderBy: async () => folders }) })
      .mockReturnValueOnce({
        from: () => ({ where: async () => [{ id: 'project-visible', folderId: 'visible-child' }] }),
      });
    const service = new PageProjectFolderService({ select } as any, { log: vi.fn() } as any);

    const tree = await service.getFolderTree({ allowedResourceIds: ['project-visible'] });

    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({
      id: 'visible-root',
      children: [{ id: 'visible-child', children: [] }],
    });
    expect(JSON.stringify(tree)).not.toContain('hidden-root');
    expect(JSON.stringify(tree)).not.toContain('project-visible');
  });

  it('validates Project limits and rejects empty updates', () => {
    expect(
      CreatePageProjectSchema.parse({ name: 'Docs', nodeId: '00000000-0000-4000-8000-000000000001' })
    ).toMatchObject({
      name: 'Docs',
      maxDeployments: 20,
      storageQuotaBytes: 1_073_741_824,
    });
    expect(() =>
      CreatePageProjectSchema.parse({
        name: 'Docs',
        nodeId: '00000000-0000-4000-8000-000000000001',
        maxDeployments: 0,
      })
    ).toThrow();
    expect(() => UpdatePageProjectSchema.parse({})).toThrow();
    expect(UpdatePageProjectSchema.parse({ appearanceColor: 'purple' })).toEqual({ appearanceColor: 'purple' });
    expect(() => UpdatePageProjectSchema.parse({ appearanceColor: 'teal' })).toThrow();
    expect(PageProjectListQuerySchema.parse({ folderId: null })).toMatchObject({ page: 1, limit: 20, folderId: null });
  });

  it('creates the reserved latest Tag and Default runtime config in the same transaction as its Project', async () => {
    const now = new Date();
    const project = {
      id: 'project-1',
      name: 'Docs',
      slug: 'docs',
      description: null,
      nodeId: '00000000-0000-4000-8000-000000000001',
      folderId: null,
      sortOrder: 0,
      maxDeployments: 20,
      storageQuotaBytes: 1_073_741_824,
      storageUsedBytes: 0,
      nextDeploymentSequence: 1,
      createdById: 'user-1',
      updatedById: 'user-1',
      createdAt: now,
      updatedAt: now,
    };
    const projectInsertValues = vi.fn().mockReturnValue({ returning: async () => [project] });
    const tagInsertValues = vi.fn().mockResolvedValue(undefined);
    const configInsertValues = vi.fn().mockResolvedValue(undefined);
    const tx = {
      insert: vi
        .fn()
        .mockReturnValueOnce({ values: projectInsertValues })
        .mockReturnValueOnce({ values: tagInsertValues })
        .mockReturnValueOnce({ values: configInsertValues }),
    };
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: '00000000-0000-4000-8000-000000000001',
                type: 'nginx',
                status: 'online',
                capabilities: { capabilities: ['nginx_pages_v1', 'nginx_pages_config_v1'] },
              },
            ],
          }),
        }),
      })
      .mockReturnValueOnce({ from: () => ({ where: async () => [{ nextSortOrder: null }] }) })
      .mockReturnValueOnce({ from: () => ({ where: async () => [{ deploymentCount: 0 }] }) })
      .mockReturnValueOnce({ from: () => ({ where: async () => [{ tagCount: 1 }] }) })
      .mockReturnValueOnce({ from: () => ({ where: async () => [{ routeCount: 0 }] }) });
    const db = { select, transaction: vi.fn(async (callback) => callback(tx)) };
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const eventBus = { publish: vi.fn() };
    const service = new PageProjectService(db as any, audit as any);
    service.setEventBus(eventBus as any);

    const created = await service.create(
      {
        name: 'Docs',
        nodeId: '00000000-0000-4000-8000-000000000001',
        description: null,
        folderId: null,
        maxDeployments: 20,
        storageQuotaBytes: 1_073_741_824,
      },
      'user-1'
    );

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(projectInsertValues).toHaveBeenCalledWith(expect.objectContaining({ name: 'Docs', slug: 'docs' }));
    expect(tagInsertValues).toHaveBeenCalledWith({
      projectId: 'project-1',
      name: 'latest',
      system: true,
      updatedById: 'user-1',
    });
    expect(configInsertValues).toHaveBeenCalledWith({
      projectId: 'project-1',
      value: {},
      updatedById: 'user-1',
    });
    expect(created).toMatchObject({ id: 'project-1', deploymentCount: 0, tagCount: 1, routeCount: 0 });
    expect(eventBus.publish).toHaveBeenCalledWith(
      'pages.project.changed',
      expect.objectContaining({ projectId: 'project-1', scopeResourceId: 'project-1', action: 'created' })
    );
  });

  it('emits bounded events with the Project ID as the scope resource', () => {
    expect(pageProjectEvent('project-1', 'ready', { id: 'deployment-1', publicSlug: 'abc234def567ghij' })).toEqual({
      projectId: 'project-1',
      scopeResourceId: 'project-1',
      action: 'ready',
      id: 'deployment-1',
      publicSlug: 'abc234def567ghij',
    });
  });

  it('migrates Pages as tag-backed Routes with immutable Deployment metadata', () => {
    const migrationName = readdirSync(join(process.cwd(), 'src/db/migrations')).find(
      (name) => name.startsWith('0128_') && name.endsWith('.sql')
    );
    expect(migrationName).toBeDefined();
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations', migrationName!), 'utf8');

    expect(migration).toContain(`ALTER TYPE "public"."proxy_upstream_kind" ADD VALUE 'pages'`);
    expect(migration).toContain('CREATE TABLE "page_deployments"');
    expect(migration).toContain('"public_slug" varchar(16) NOT NULL');
    expect(migration).toContain('CREATE TABLE "page_tags"');
    expect(migration).toContain('CREATE TABLE "page_route_targets"');
    expect(migration).toContain('"tag_id" uuid NOT NULL');
    expect(migration).not.toContain('"environment_id"');
  });
});
