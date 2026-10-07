import { describe, expect, it } from 'vitest';
import {
  assertTokenRegistryAccessAllowed,
  ownerMayUseRegistry,
  splitRegistryScopes,
  tokenAllowsRegistryAction,
  tokenRegistryAccess,
} from './token-registry-access.js';

const FOLDER = 'folder/0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e';

describe('token registry access', () => {
  it('reads the registry scopes of older tokens as registry access', () => {
    expect(
      tokenRegistryAccess({
        registryAccess: { push: ['team/web'] },
        scopes: ['nodes:details', 'docker:registries:internal:pull', 'docker:registries:internal:push:team/app'],
      })
    ).toEqual({ pull: 'all', push: ['team/app', 'team/web'] });
    expect(splitRegistryScopes(['proxy:view', 'docker:registries:internal:pull:team/app'])).toEqual({
      scopes: ['proxy:view'],
      registryAccess: { pull: ['team/app'] },
    });
  });

  it('lets workload viewers give pull and workload editors push, anywhere they hold it', () => {
    expect(ownerMayUseRegistry([`docker:containers:view:${FOLDER}`], 'pull')).toBe(true);
    expect(ownerMayUseRegistry(['docker:images:view:node-1'], 'pull')).toBe(true);
    expect(ownerMayUseRegistry(['docker:compose:view'], 'pull')).toBe(true);
    expect(ownerMayUseRegistry(['docker:containers:view'], 'push')).toBe(false);
    expect(ownerMayUseRegistry(['docker:containers:edit:node-1/app'], 'push')).toBe(true);
    expect(ownerMayUseRegistry(['docker:compose:manage'], 'push')).toBe(true);
    // Creating a workload names a destination, not an existing workload.
    expect(ownerMayUseRegistry(['docker:containers:create'], 'pull')).toBe(false);
    expect(ownerMayUseRegistry(['docker:registries:view'], 'pull')).toBe(false);
  });

  it('keeps a legacy registry grant per repository', () => {
    const owner = ['docker:registries:internal:push:team/app'];
    expect(ownerMayUseRegistry(owner, 'push', 'team/app')).toBe(true);
    expect(ownerMayUseRegistry(owner, 'push', 'team/other')).toBe(false);
    expect(ownerMayUseRegistry(owner, 'pull', 'team/app')).toBe(false);
  });

  it('refuses registry access the owner cannot give', () => {
    expect(() => assertTokenRegistryAccessAllowed({ pull: 'all', push: 'all' }, ['docker:containers:view'])).toThrow(
      expect.objectContaining({ statusCode: 403, code: 'REGISTRY_ACCESS_NOT_ALLOWED' })
    );
    expect(() =>
      assertTokenRegistryAccessAllowed({ pull: 'all', push: ['team/app'] }, ['docker:containers:manage'])
    ).not.toThrow();
    expect(() =>
      assertTokenRegistryAccessAllowed({ push: ['team/other'] }, ['docker:registries:internal:push:team/app'])
    ).toThrow(expect.objectContaining({ code: 'REGISTRY_ACCESS_NOT_ALLOWED' }));
  });

  it('matches narrowed repositories exactly and rechecks the owner on every request', () => {
    const access = { pull: ['team/app'], push: ['team/app'] };
    expect(tokenAllowsRegistryAction(access, ['docker:containers:manage'], 'push', 'team/app')).toBe(true);
    expect(tokenAllowsRegistryAction(access, ['docker:containers:manage'], 'pull', 'team/app-two')).toBe(false);
    expect(tokenAllowsRegistryAction(access, ['docker:containers:manage'], 'pull', 'team')).toBe(false);
    // The owner was demoted to a viewer: pull stays, push goes.
    expect(tokenAllowsRegistryAction(access, ['docker:containers:view'], 'pull', 'team/app')).toBe(true);
    expect(tokenAllowsRegistryAction(access, ['docker:containers:view'], 'push', 'team/app')).toBe(false);
    expect(tokenAllowsRegistryAction({}, ['docker:containers:manage'], 'pull', 'team/app')).toBe(false);
  });
});
