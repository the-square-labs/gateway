import { describe, expect, it } from 'vitest';
import { CreateTokenSchema, UpdateTokenSchema } from './tokens.schemas.js';

describe('CreateTokenSchema', () => {
  it('rejects user-only AI scopes for API tokens', () => {
    const result = CreateTokenSchema.safeParse({
      name: 'CI token',
      scopes: ['nodes:details', 'ai:workspace:use'],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      'One or more scopes cannot be granted to API tokens'
    );
  });

  it('rejects impersonation for API tokens', () => {
    const result = CreateTokenSchema.safeParse({
      name: 'CI token',
      scopes: ['nodes:details', 'admin:users:impersonate'],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      'One or more scopes cannot be granted to API tokens'
    );
  });

  it('allows delegable scopes for API tokens', () => {
    const result = CreateTokenSchema.safeParse({
      name: 'CI token',
      scopes: ['nodes:details', 'proxy:view'],
    });

    expect(result.success).toBe(true);
  });

  it('allows administration, settings, raw config, and hosting scopes for API tokens', () => {
    const result = CreateTokenSchema.safeParse({
      name: 'Automation',
      scopes: [
        'admin:system',
        'admin:users',
        'admin:groups',
        'settings:gateway:edit',
        'proxy:raw:write:host-1',
        'nodes:manage',
        'hosting:resources:create',
        'inference:providers:manage',
      ],
    });

    expect(result.success).toBe(true);
  });

  it('rejects mcp:use for API tokens', () => {
    const result = CreateTokenSchema.safeParse({
      name: 'CI token',
      scopes: ['nodes:details', 'mcp:use'],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      'One or more scopes cannot be granted to API tokens'
    );
  });
});

describe('API token scope targets', () => {
  const folderId = '0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e';

  it('accepts folder, node, and Docker child targets where the base supports them', () => {
    const result = CreateTokenSchema.safeParse({
      name: 'Folder token',
      scopes: [
        `docker:containers:manage:folder/${folderId}`,
        'docker:containers:view:node-1/container_1.web',
        'docker:images:view:node-1/sha256:abc123',
        `proxy:create:node/node-1`,
        `logs:tokens:create:folder/${folderId}`,
        'docker:registries:internal:pull:team/app/web',
        'integrations:hosting:view:provider/hetzner',
      ],
    });

    expect(result.success).toBe(true);
  });

  it('rejects folder targets on bases that cannot be restricted to folders', () => {
    for (const scope of [
      `pki:cert:view:folder/${folderId}`,
      `docker:tasks:folder/${folderId}`,
      'docker:containers:view:folder/not-a-uuid',
      'nodes:details:node/node-1',
      'proxy:view:node-1/host-1',
      'docker:containers:view:node-1/a/b',
      'integrations:hosting:view:provider/unknown',
      'settings:gateway:view:anything',
      `proxy:view:${'x'.repeat(520)}`,
    ]) {
      expect(CreateTokenSchema.safeParse({ name: 'Bad', scopes: [scope] }).success, scope).toBe(false);
    }
  });

  it('still accepts retired scope names from older clients', () => {
    const result = CreateTokenSchema.safeParse({
      name: 'Legacy client',
      scopes: ['nodes:config:edit:node-1', 'proxy:advanced:bypass', 'ssl:cert:export', 'notifications:manage'],
    });

    expect(result.success).toBe(true);
  });

  it('caps the number of scopes', () => {
    const scopes = Array.from({ length: 5001 }, (_, index) => `proxy:view:host-${index}`);
    expect(CreateTokenSchema.safeParse({ name: 'Too many', scopes }).success).toBe(false);
  });
});

describe('UpdateTokenSchema', () => {
  it('allows updating scopes without renaming the token', () => {
    const result = UpdateTokenSchema.safeParse({
      scopes: ['nodes:details', 'proxy:view'],
    });

    expect(result.success).toBe(true);
  });

  it('rejects an update without any fields', () => {
    const result = UpdateTokenSchema.safeParse({});

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain('At least one field is required');
  });
});
