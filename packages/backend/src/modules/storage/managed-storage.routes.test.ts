import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { requireManagedStorageScopes } from './managed-storage.routes.js';

const MANAGED_STORAGE_ID = '66666666-6666-4666-8666-666666666666';
const CANONICAL_CONNECTION_ID = '77777777-7777-4777-8777-777777777777';

function middlewareContext(scopes: string[]) {
  return {
    get: vi.fn(() => scopes),
    req: { param: vi.fn(() => MANAGED_STORAGE_ID) },
  } as never;
}

describe('managed storage route scopes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects a caller with neither a direct nor canonical-resource scope', async () => {
    const getCanonicalScopeResourceId = vi.fn().mockResolvedValue(CANONICAL_CONNECTION_ID);
    vi.spyOn(container, 'resolve').mockReturnValue({ getCanonicalScopeResourceId } as never);
    const next = vi.fn();

    await expect(requireManagedStorageScopes('storage:edit')(middlewareContext([]), next)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    expect(getCanonicalScopeResourceId).toHaveBeenCalledWith(MANAGED_STORAGE_ID);
    expect(next).not.toHaveBeenCalled();
  });

  it('checks a scoped grant against the canonical object storage connection', async () => {
    const getCanonicalScopeResourceId = vi.fn().mockResolvedValue(CANONICAL_CONNECTION_ID);
    vi.spyOn(container, 'resolve').mockReturnValue({ getCanonicalScopeResourceId } as never);
    const next = vi.fn();

    await requireManagedStorageScopes('storage:edit')(
      middlewareContext([`storage:edit:${CANONICAL_CONNECTION_ID}`]),
      next
    );

    expect(next).toHaveBeenCalledOnce();
  });

  it('grants access immediately when the direct (non-resource-scoped) scope is present', async () => {
    const getCanonicalScopeResourceId = vi.fn();
    vi.spyOn(container, 'resolve').mockReturnValue({ getCanonicalScopeResourceId } as never);
    const next = vi.fn();

    await requireManagedStorageScopes('storage:view')(middlewareContext(['storage:view']), next);

    expect(getCanonicalScopeResourceId).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('requires every requested scope base to resolve against the canonical resource', async () => {
    const getCanonicalScopeResourceId = vi.fn().mockResolvedValue(CANONICAL_CONNECTION_ID);
    vi.spyOn(container, 'resolve').mockReturnValue({ getCanonicalScopeResourceId } as never);
    const next = vi.fn();

    await expect(
      requireManagedStorageScopes('storage:edit', 'storage:credentials:reveal')(
        middlewareContext([`storage:edit:${CANONICAL_CONNECTION_ID}`]),
        next
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(next).not.toHaveBeenCalled();
  });
});
