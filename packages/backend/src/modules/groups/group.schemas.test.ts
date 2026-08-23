import { describe, expect, it } from 'vitest';
import { CreateGroupSchema, UpdateGroupSchema } from './group.schemas.js';

const VALID_GROUP = {
  name: 'custom-operators',
  description: 'Custom operators',
  scopes: ['nodes:details'],
};

describe('group schemas', () => {
  it('rejects admin:system for custom groups', () => {
    expect(CreateGroupSchema.safeParse({ ...VALID_GROUP, scopes: ['admin:system'] }).success).toBe(false);
    expect(UpdateGroupSchema.safeParse({ scopes: ['admin:system'] }).success).toBe(false);
  });

  it('rejects the OAuth-only inference setup scope for custom groups', () => {
    expect(CreateGroupSchema.safeParse({ ...VALID_GROUP, scopes: ['inference:setup'] }).success).toBe(false);
    expect(UpdateGroupSchema.safeParse({ scopes: ['inference:setup'] }).success).toBe(false);
  });

  it('allows valid custom group scopes', () => {
    expect(CreateGroupSchema.safeParse(VALID_GROUP).success).toBe(true);
    expect(UpdateGroupSchema.safeParse({ scopes: ['logs:schemas:view:schema-1'] }).success).toBe(true);
  });

  it('allows custom groups without direct scopes', () => {
    expect(CreateGroupSchema.safeParse({ ...VALID_GROUP, scopes: [] }).success).toBe(true);
    expect(UpdateGroupSchema.safeParse({ scopes: [] }).success).toBe(true);
  });
});
