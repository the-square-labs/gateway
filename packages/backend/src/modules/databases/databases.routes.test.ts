import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { assertManagedDatabaseBindingTargetAccess, requireManagedDatabaseScopes } from './databases.routes.js';

const MANAGED_DATABASE_ID = '44444444-4444-4444-8444-444444444444';
const CANONICAL_DATABASE_ID = '55555555-5555-4555-8555-555555555555';

function middlewareContext(scopes: string[]) {
  return {
    get: vi.fn(() => scopes),
    req: { param: vi.fn(() => MANAGED_DATABASE_ID) },
  } as never;
}

describe('managed database route scopes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requires credential-reveal permission as well as edit permission to rotate direct credentials', async () => {
    const getCanonicalScopeResourceId = vi.fn().mockResolvedValue(CANONICAL_DATABASE_ID);
    vi.spyOn(container, 'resolve').mockReturnValue({ getCanonicalScopeResourceId } as never);
    const next = vi.fn();

    await expect(
      requireManagedDatabaseScopes('databases:edit', 'databases:credentials:reveal')(
        middlewareContext([`databases:edit:${CANONICAL_DATABASE_ID}`]),
        next
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(getCanonicalScopeResourceId).toHaveBeenCalledWith(MANAGED_DATABASE_ID);
    expect(next).not.toHaveBeenCalled();
  });

  it('checks a scoped grant against the canonical database resource', async () => {
    const getCanonicalScopeResourceId = vi.fn().mockResolvedValue(CANONICAL_DATABASE_ID);
    vi.spyOn(container, 'resolve').mockReturnValue({ getCanonicalScopeResourceId } as never);
    const next = vi.fn();

    await requireManagedDatabaseScopes('databases:edit', 'databases:credentials:reveal')(
      middlewareContext([
        `databases:edit:${CANONICAL_DATABASE_ID}`,
        `databases:credentials:reveal:${CANONICAL_DATABASE_ID}`,
      ]),
      next
    );

    expect(next).toHaveBeenCalledOnce();
  });

  it('does not inspect a deleted binding target for node-wide cleanup scopes', async () => {
    const inspectContainer = vi.fn();
    vi.spyOn(container, 'resolve').mockReturnValue({ inspectContainer } as never);
    const nodeId = 'node-1';
    const scopes = [
      'docker:containers:environment',
      'docker:containers:secrets',
      'docker:networks:create',
      'docker:networks:edit',
      'docker:networks:delete',
    ];

    await expect(
      assertManagedDatabaseBindingTargetAccess(
        { get: vi.fn(() => scopes) },
        { targetNodeId: nodeId, targetType: 'container', targetResourceId: 'gone' }
      )
    ).resolves.toBeUndefined();

    expect(inspectContainer).not.toHaveBeenCalled();
  });
});
