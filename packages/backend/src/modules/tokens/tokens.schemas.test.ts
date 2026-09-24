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
        'nodes:config:edit',
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
