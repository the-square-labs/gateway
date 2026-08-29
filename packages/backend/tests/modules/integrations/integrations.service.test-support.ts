import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

export const BASE_USER = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: [] as string[],
  isBlocked: false,
};

export function connectorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    provider: 'gitlab',
    name: 'Main GitLab',
    baseUrl: 'https://gitlab.example.com',
    enabled: true,
    encryptedToken: 'encrypted-token',
    tokenLast4: 'abcd',
    allowlistMode: 'selected',
    settings: {
      autoSyncEnabled: true,
      autoSyncIntervalSeconds: 900,
      cloneShallow: true,
      cloneDepth: 1,
      cloneLfs: false,
      cloneSubmodules: false,
      cloneMaxSizeMb: 1024,
      cloneTimeoutSeconds: 300,
    },
    capabilities: { projectsView: true },
    syncStatus: 'never',
    syncLastError: null,
    syncFailureCount: 0,
    syncStartedAt: null,
    syncFinishedAt: null,
    syncLastOverlapAt: null,
    syncNextRetryAt: null,
    testedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function createListDb(rows: unknown[]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn().mockResolvedValue(rows),
        })),
      })),
    })),
  };
}

export function createGetDb(row: unknown) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([row]),
        })),
      })),
    })),
  };
}

export function createGetUpdateDb(row: unknown) {
  return {
    ...createGetDb(row),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    })),
  };
}

export function createCloudflareDeleteInUseDb(connector: unknown) {
  const select = vi.fn();
  select
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([connector]),
        })),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{ id: 'domain-1', domain: 'example.com' }]),
        })),
      })),
    });
  return { select, delete: vi.fn() };
}

export function createToolProjectsDb(input: { connector: unknown; projects: unknown[]; allowlistEntries: unknown[] }) {
  const select = vi.fn();
  select
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([input.connector]),
        })),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue(input.projects),
          })),
        })),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn().mockResolvedValue(input.allowlistEntries),
        })),
      })),
    });
  return { select };
}

export function createDockerSourceListDb(input: { connector: unknown; projects: unknown[]; allowlistEntries: unknown[] }) {
  const select = vi.fn();
  select
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([input.connector]),
        })),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn().mockResolvedValue(input.projects),
        })),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn().mockResolvedValue(input.allowlistEntries),
        })),
      })),
    });
  return { select };
}

export function createDockerSourceResolveDb(input: { connector: unknown; project: unknown; allowlistEntries: unknown[] }) {
  const select = vi.fn();
  select
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([{ connector: input.connector, project: input.project }]),
          })),
        })),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn().mockResolvedValue(input.allowlistEntries),
        })),
      })),
    });
  return { select };
}

export function createProjectActionDb(input: { connector: unknown; project: unknown; allowlistEntries: unknown[] }) {
  const select = vi.fn();
  select
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([input.connector]),
        })),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([input.project]),
        })),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn().mockResolvedValue(input.allowlistEntries),
        })),
      })),
    });
  return {
    select,
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    })),
  };
}

export function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'project-row-1',
    connectorId: '11111111-1111-4111-8111-111111111111',
    remoteId: '28',
    fullPath: 'general/balanceify',
    name: 'balanceify',
    webUrl: 'https://gitlab.example.com/general/balanceify',
    visibility: 'private',
    defaultBranch: 'main',
    archived: false,
    lastSeenAt: new Date('2026-01-01T00:00:00Z'),
    inaccessibleAt: null,
    metadata: {},
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function vcsProvider<T extends Record<string, unknown>>(overrides: T) {
  return {
    provider: 'gitlab',
    readFile: vi.fn(),
    createBranch: vi.fn(),
    commitFiles: vi.fn(),
    updateProjectSettings: vi.fn(),
    downloadRepositoryArchive: vi.fn(),
    ...overrides,
  };
}
