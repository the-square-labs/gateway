import { describe, expect, it } from 'vitest';
import { hasScope } from '@/lib/permissions.js';
import { API_TOKEN_SCOPES, isValidBaseScope } from '@/lib/scopes.js';
import { HostingSettingsSchema } from './hosting.schemas.js';
import {
  assertHostingAdoptionAuthority,
  assertHostingResourceAction,
  canViewHostingFinance,
} from './hosting-permissions.js';

describe('hosting authorization boundaries', () => {
  it('registers scoped permissions without implicit node-to-finance grants', () => {
    expect(isValidBaseScope('hosting:resources:power')).toBe(true);
    expect(hasScope(['hosting:resources:power:r1'], 'hosting:resources:power:r2')).toBe(false);
    expect(canViewHostingFinance(['nodes:details', 'integrations:hosting:manage'], 'account')).toBe(false);
    expect(canViewHostingFinance(['hosting:billing:view:account'], 'account')).toBe(true);
    expect(canViewHostingFinance(['hosting:billing:view:other'], 'account')).toBe(false);
    expect(API_TOKEN_SCOPES).not.toContain('hosting:billing:topup');
    for (const scope of [
      'integrations:hosting:manage',
      'hosting:resources:create',
      'hosting:resources:power',
      'hosting:resources:resize',
      'hosting:resources:delete',
      'hosting:resources:recover',
      'hosting:billing:view',
    ])
      expect(API_TOKEN_SCOPES).not.toContain(scope);
  });
  it('does not authorize global adoption from a single-node grant', () => {
    const scopes = ['nodes:details:n1', 'nodes:config:edit:n1'];
    expect(() => assertHostingAdoptionAuthority(scopes, HostingSettingsSchema.parse({}))).toThrow();
    expect(() =>
      assertHostingAdoptionAuthority(
        scopes,
        HostingSettingsSchema.parse({ adoptionNodeIds: ['11111111-1111-4111-8111-111111111111'] })
      )
    ).toThrow();
    expect(() =>
      assertHostingAdoptionAuthority(scopes, { ...HostingSettingsSchema.parse({}), adoptionNodeIds: ['n1'] })
    ).not.toThrow();
  });
  it('requires rights for all impacted roles before power/delete', () => {
    const scopes = ['hosting:resources:power:r1', 'nodes:details', 'nodes:config:edit:n1'];
    expect(() => assertHostingResourceAction(scopes, 'r1', 'reboot', ['n1'])).not.toThrow();
    expect(() => assertHostingResourceAction(scopes, 'r1', 'reboot', ['n1', 'n2'])).toThrow();
    expect(() => assertHostingResourceAction(scopes, 'r1', 'delete', ['n1'])).toThrow();
  });
});
