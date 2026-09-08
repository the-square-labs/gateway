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

  it('accepts folder and Docker child restrictions when creating and updating groups', () => {
    const folder = 'd0367778-e2ee-42d7-bbc4-9ba1bb219578';
    const scopes = [
      `databases:edit:folder/${folder}`,
      `databases:query:read:folder/${folder}`,
      `databases:query:write:folder/${folder}`,
      `databases:view:folder/${folder}`,
      ...[
        'config',
        'console',
        'edit',
        'environment',
        'files:read',
        'files:write',
        'manage',
        'migrate',
        'secrets',
        'view',
      ].map((action) => `docker:containers:${action}:folder/99b0aa96-0de0-4983-acf7-a45c288df833`),
      'docker:containers:secrets:49b5e58f-c373-4633-aa68-23de36d09f99/260a250c-3590-4840-88d1-75c93c99883c',
      'proxy:edit:6956fd71-3ad1-4955-b439-74650c4d4b62',
      'proxy:maintenance:bypass:6956fd71-3ad1-4955-b439-74650c4d4b62',
      'proxy:view:6956fd71-3ad1-4955-b439-74650c4d4b62',
    ];
    expect(CreateGroupSchema.parse({ ...VALID_GROUP, name: 'unicorns-operator', scopes }).scopes).toEqual(scopes);
    expect(UpdateGroupSchema.parse({ scopes }).scopes).toEqual(scopes);
  });

  it.each([
    'databases:view:folder/',
    'databases:view:folder//id',
    'databases:view:folder/id bad',
    'unknown:view:folder/id',
  ])('rejects malformed scope %s', (scope) => {
    expect(CreateGroupSchema.safeParse({ ...VALID_GROUP, scopes: [scope] }).success).toBe(false);
  });

  it('allows custom groups without direct scopes', () => {
    expect(CreateGroupSchema.safeParse({ ...VALID_GROUP, scopes: [] }).success).toBe(true);
    expect(UpdateGroupSchema.safeParse({ scopes: [] }).success).toBe(true);
  });
});
