import { describe, expect, it, vi } from 'vitest';
import { expandFolderScopes } from './folder-scopes.js';
import { boundScopes, hasScope, hasScopeForCreation, scopeMatcher } from './permissions.js';
import {
  ADMIN_SCOPES,
  canonicalizeScopes,
  FOLDER_CREATION_SCOPES,
  isApiTokenScope,
  SYSTEM_ADMIN_SCOPES,
} from './scopes.js';

/**
 * A folder-restricted token (API token or OAuth/MCP grant) owned by an administrator with broad scopes:
 * the effective scopes must stay inside the granted folder, whatever the owner holds.
 */

const NODE = '11111111-1111-4111-8111-111111111111';
const FOLDER = '22222222-2222-4222-8222-222222222222';
const SUBFOLDER = '33333333-3333-4333-8333-333333333333';
const OTHER_FOLDER = '44444444-4444-4444-8444-444444444444';

/** The owner's creator grants: per-resource scopes on resources outside the token's folder. */
const OWNER_CREATOR_GRANTS = [
  `docker:containers:view:${NODE}/root-container`,
  `docker:containers:manage:${NODE}/root-container`,
  'proxy:view:root-host',
  'proxy:edit:root-host',
];

/** Docker container folders F > F/sub plus one unrelated folder, with one container in F. */
function dockerDb() {
  const select = vi.fn((fields: Record<string, unknown>) => ({
    from: vi.fn(() => {
      if ('parentId' in fields && 'resourceType' in fields) {
        return Promise.resolve([
          { id: FOLDER, parentId: null, resourceType: 'container' },
          { id: SUBFOLDER, parentId: FOLDER, resourceType: 'container' },
          { id: OTHER_FOLDER, parentId: null, resourceType: 'container' },
        ]);
      }
      if ('folderId' in fields) {
        return {
          where: vi
            .fn()
            .mockResolvedValue([
              { folderId: FOLDER, nodeId: NODE, resourceType: 'container', resourceKey: 'in-folder' },
            ]),
        };
      }
      if ('resourceKey' in fields) {
        return { where: vi.fn().mockResolvedValue([{ id: 'in-folder-id', nodeId: NODE, resourceKey: 'in-folder' }]) };
      }
      return { where: vi.fn().mockResolvedValue([]) };
    }),
  }));
  return { select } as never;
}

/** Plain (non-Docker) folder families: F > F/sub plus an unrelated folder, with one resource in F. */
function simpleDb() {
  const select = vi.fn((fields: Record<string, unknown>) => ({
    from: vi.fn(() =>
      'parentId' in fields
        ? Promise.resolve([
            { id: FOLDER, parentId: null },
            { id: SUBFOLDER, parentId: FOLDER },
            { id: OTHER_FOLDER, parentId: null },
          ])
        : { where: vi.fn().mockResolvedValue([{ id: 'in-folder-id', folderId: FOLDER }]) }
    ),
  }));
  return { select } as never;
}

/** What validateToken / OAuth validateAccessToken compute: expand the grant, then bound it by the owner. */
async function tokenEffectiveScopes(db: never, tokenScopes: string[], ownerScopes: readonly string[]) {
  const expanded = await expandFolderScopes(db, tokenScopes.filter(isApiTokenScope));
  return canonicalizeScopes(boundScopes(expanded, ownerScopes).filter(isApiTokenScope));
}

const OWNERS: Array<[string, readonly string[]]> = [
  ['system administrator', [...SYSTEM_ADMIN_SCOPES, ...OWNER_CREATOR_GRANTS]],
  ['administrator', [...ADMIN_SCOPES, ...OWNER_CREATOR_GRANTS]],
];

describe('folder-restricted tokens cannot escape their folder', () => {
  describe.each(OWNERS)('owned by a %s', (_label, owner) => {
    it('Docker containers: create only in the folder, see only its contents', async () => {
      const scopes = await tokenEffectiveScopes(
        dockerDb(),
        [
          `docker:containers:view:folder/${FOLDER}`,
          `docker:containers:create:folder/${FOLDER}`,
          `docker:containers:manage:folder/${FOLDER}`,
        ],
        owner
      );
      // Root placement needs a broad or node-level create grant; another folder needs its own grant.
      expect(hasScopeForCreation(scopes, 'docker:containers:create', null, NODE)).toBe(false);
      expect(hasScopeForCreation(scopes, 'docker:containers:create', undefined, NODE)).toBe(false);
      expect(hasScopeForCreation(scopes, 'docker:containers:create', OTHER_FOLDER, NODE)).toBe(false);
      expect(hasScopeForCreation(scopes, 'docker:containers:create', FOLDER, NODE)).toBe(true);
      expect(hasScopeForCreation(scopes, 'docker:containers:create', SUBFOLDER, NODE)).toBe(true);
      // No broad, node or node/ grant leaks from the owner.
      for (const base of ['docker:containers:create', 'docker:containers:view', 'docker:containers:manage']) {
        expect(hasScope(scopes, base)).toBe(false);
        expect(hasScope(scopes, `${base}:${NODE}`)).toBe(false);
        expect(hasScope(scopes, `${base}:node/${NODE}`)).toBe(false);
      }
      // Reads follow the folder: its container yes, the owner's root container no.
      expect(hasScope(scopes, `docker:containers:view:${NODE}/in-folder-id`)).toBe(true);
      expect(hasScope(scopes, `docker:containers:view:${NODE}/root-container`)).toBe(false);
      expect(hasScope(scopes, `docker:containers:manage:${NODE}/root-container`)).toBe(false);
    });

    it.each(
      FOLDER_CREATION_SCOPES.filter((base) => !base.startsWith('docker:'))
    )('%s: a folder grant never authorizes the root or another folder', async (base) => {
      const scopes = await tokenEffectiveScopes(simpleDb(), [`${base}:folder/${FOLDER}`], owner);
      expect(hasScopeForCreation(scopes, base, null)).toBe(false);
      expect(hasScopeForCreation(scopes, base, null, NODE)).toBe(false);
      expect(hasScopeForCreation(scopes, base, OTHER_FOLDER)).toBe(false);
      expect(hasScopeForCreation(scopes, base, FOLDER)).toBe(true);
      expect(hasScopeForCreation(scopes, base, SUBFOLDER)).toBe(true);
      expect(hasScope(scopes, base)).toBe(false);
    });

    it('proxy routes: view and edit stay on the folder contents', async () => {
      const scopes = await tokenEffectiveScopes(
        simpleDb(),
        [`proxy:view:folder/${FOLDER}`, `proxy:edit:folder/${FOLDER}`, `proxy:create:folder/${FOLDER}`],
        owner
      );
      const holds = scopeMatcher(scopes);
      expect(holds('proxy:view:in-folder-id')).toBe(true);
      expect(holds('proxy:edit:in-folder-id')).toBe(true);
      expect(holds('proxy:view:root-host')).toBe(false);
      expect(holds('proxy:edit:root-host')).toBe(false);
      expect(holds('proxy:view')).toBe(false);
    });
  });
});
