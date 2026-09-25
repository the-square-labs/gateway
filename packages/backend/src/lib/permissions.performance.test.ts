import { describe, expect, it } from 'vitest';
import { boundScopes, hasScope, isScopeSubset } from './permissions.js';
import { ADMIN_SCOPES, canonicalizeScopes } from './scopes.js';

const FOLDER = 'folder/0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e';

/** What folder expansion produces for a grant on a folder holding `count` resources. */
function expandedFolderGrant(bases: readonly string[], count: number): string[] {
  return bases.flatMap((base) => [
    `${base}:${FOLDER}`,
    ...Array.from({ length: count }, (_, index) => `${base}:resource-${index}`),
  ]);
}

/** Best of five runs, so a busy CI worker (parallel test files) does not flip the assertion. */
function timed<T>(run: () => T): { result: T; ms: number } {
  let result = run();
  let ms = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const started = performance.now();
    result = run();
    ms = Math.min(ms, performance.now() - started);
  }
  return { result, ms };
}

describe('scope bounding performance', () => {
  // A MyProject token (view + edit + delete on one folder) over 5000 routes: 15000 expanded scopes each side.
  const bases = ['proxy:view', 'proxy:edit', 'proxy:delete'];

  it('bounds 5000 expanded token scopes by a folder-scoped owner in under 50 ms', () => {
    const token = expandedFolderGrant(['proxy:view'], 5000);
    const owner = expandedFolderGrant(['proxy:view', 'proxy:edit'], 5000);

    const { result, ms } = timed(() => boundScopes(token, owner));

    expect(new Set(result)).toEqual(new Set(token));
    expect(ms).toBeLessThan(50);
  });

  it('bounds 5000 expanded token scopes by a broad administrator in under 50 ms', () => {
    const token = expandedFolderGrant(['proxy:view'], 5000);
    const owner = [...ADMIN_SCOPES];

    const { result, ms } = timed(() => canonicalizeScopes(boundScopes(token, owner)));

    expect(result).toHaveLength(token.length);
    expect(ms).toBeLessThan(50);
  });

  it('bounds a broad token by a folder-scoped owner with 5000 resources in under 50 ms', () => {
    const owner = expandedFolderGrant(['proxy:edit'], 5000);
    const { result, ms } = timed(() => boundScopes(['proxy:view', 'proxy:edit'], owner));

    // The broad token narrows to the owner's folder and resources, including view implied by edit.
    expect(result).toEqual(expect.arrayContaining([`proxy:view:${FOLDER}`, 'proxy:view:resource-4999']));
    expect(result).not.toContain('proxy:view');
    expect(ms).toBeLessThan(50);
  });

  it('compares two expanded 5000-resource scope sets (15000 scopes) for user management in under 50 ms', () => {
    const actor = expandedFolderGrant(bases, 5000);
    const target = expandedFolderGrant(['proxy:view'], 5000);
    const { result, ms } = timed(() => isScopeSubset(target, actor));

    expect(result).toBe(true);
    expect(hasScope(actor, 'proxy:view:resource-17')).toBe(true);
    expect(ms).toBeLessThan(50);
  });
});
