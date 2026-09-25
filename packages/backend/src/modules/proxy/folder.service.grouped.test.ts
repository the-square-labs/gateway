import 'reflect-metadata';
import '@/db/schema/index.js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./proxy-upstream-display.js', () => ({
  attachDockerUpstreamDisplay: async (_db: unknown, hosts: unknown[]) => hosts,
}));

import { FolderService } from './folder.service.js';

const GRANTED = '11111111-1111-4111-8111-111111111111';
const GRANTED_CHILD = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

function folder(id: string, parentId: string | null, depth: number) {
  return {
    id,
    name: id.slice(0, 4),
    parentId,
    depth,
    sortOrder: 0,
    createdById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function host(id: string, folderId: string | null) {
  return {
    id,
    folderId,
    domainNames: [`${id}.example.com`],
    isSystem: false,
    rawConfigEnabled: false,
    healthStatus: 'online',
    healthHistory: [],
    sortOrder: 0,
    createdAt: new Date(),
  };
}

function serviceWith(folders: ReturnType<typeof folder>[], hosts: ReturnType<typeof host>[]) {
  // Folders are read with from().orderBy(), routes with from().where().orderBy().
  const db = {
    select: () => ({
      from: () => ({ orderBy: async () => folders, where: () => ({ orderBy: async () => hosts }) }),
    }),
  };
  return new FolderService(db as never, {} as never);
}

const folders = [folder(GRANTED, null, 0), folder(GRANTED_CHILD, GRANTED, 1), folder(OTHER, null, 0)];

describe('FolderService.getGroupedHosts with folder grants', () => {
  it('keeps granted folders visible while they hold no visible route', async () => {
    const result = await serviceWith(folders, []).getGroupedHosts({} as never, {
      allowedHostIds: [],
      allowedFolderIds: [GRANTED, GRANTED_CHILD],
    });

    expect(result.folders.map((node) => node.id)).toEqual([GRANTED]);
    expect(result.folders[0]?.children.map((node) => node.id)).toEqual([GRANTED_CHILD]);
    expect(result.totalHosts).toBe(0);
  });

  it('shows granted empty folders next to folders reached through visible routes only', async () => {
    const result = await serviceWith(folders, [host('host-1', OTHER)]).getGroupedHosts({} as never, {
      allowedHostIds: ['host-1'],
      allowedFolderIds: [GRANTED_CHILD],
    });

    expect(result.folders.map((node) => node.id)).toEqual([GRANTED, OTHER]);
    expect(result.folders[0]?.children.map((node) => node.id)).toEqual([GRANTED_CHILD]);
    expect(result.folders[1]?.hosts.map((row) => row.id)).toEqual(['host-1']);
  });

  it('still hides empty folders without a folder grant', async () => {
    const result = await serviceWith(folders, []).getGroupedHosts({} as never, { allowedHostIds: [] });

    expect(result.folders).toEqual([]);
  });
});
