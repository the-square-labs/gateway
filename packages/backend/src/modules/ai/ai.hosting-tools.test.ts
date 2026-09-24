import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { HostingConnectorsService } from '@/modules/hosting/hosting-connectors.service.js';
import { HostingManagementService } from '@/modules/hosting/hosting-management.service.js';
import { HostingProvisioningService } from '@/modules/hosting/hosting-provisioning.service.js';
import { executeHostingTool } from './ai.hosting-tools.js';
import { getOpenAITools, validateAIToolArguments } from './ai.tools.js';

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc:user',
  email: 'user@example.com',
  name: 'User',
  avatarUrl: null,
  groupId: '22222222-2222-4222-8222-222222222222',
  groupName: 'Operators',
  scopes: ['hosting:resources:power'] as string[],
  isBlocked: false,
};
const CONNECTOR_ID = '33333333-3333-4333-8333-333333333333';
const RESOURCE_ID = '44444444-4444-4444-8444-444444444444';

describe('manage_hosting AI tool', () => {
  afterEach(() => container.reset());

  it('is advertised for hosting scopes and rejects unknown operations and arguments', () => {
    const names = (scopes: string[]) =>
      getOpenAITools([], scopes, false, { discoveredToolsets: ['Hosting'] }).map((tool) => tool.function.name);
    expect(names(['hosting:resources:power'])).toContain('manage_hosting');
    expect(names(['proxy:view'])).not.toContain('manage_hosting');
    expect(validateAIToolArguments('manage_hosting', { operation: 'topup' })).toMatchObject({ ok: false });
    expect(validateAIToolArguments('manage_hosting', { operation: 'connector_list', secret: 'x' })).toMatchObject({
      ok: false,
    });
  });

  it('passes the acting user to the hosting services that enforce the route permissions', async () => {
    const action = vi.fn().mockResolvedValue({ operationId: 'op-1' });
    container.registerInstance(HostingManagementService, { action } as unknown as HostingManagementService);

    await expect(
      executeHostingTool(USER, 'manage_hosting', {
        operation: 'resource_action',
        resourceId: RESOURCE_ID,
        input: {
          action: 'reboot',
          idempotencyKey: '55555555-5555-4555-8555-555555555555',
          expectedIncarnation: 'inc-1',
          confirmed: true,
        },
      })
    ).resolves.toEqual({ operationId: 'op-1' });
    expect(action).toHaveBeenCalledWith(RESOURCE_ID, expect.objectContaining({ action: 'reboot' }), USER);

    // Bodies are validated with the hosting route schemas before any provider call.
    await expect(
      executeHostingTool(USER, 'manage_hosting', {
        operation: 'resource_action',
        resourceId: RESOURCE_ID,
        input: { action: 'format-disk' },
      })
    ).rejects.toThrow();
    expect(action).toHaveBeenCalledTimes(1);
    await expect(
      executeHostingTool(USER, 'manage_hosting', { operation: 'resource_action', resourceId: 'vm-1', input: {} })
    ).rejects.toThrow('resourceId must be a UUID');
  });

  it('keeps connector secrets out of connector_get and routes provisioning with the actor', async () => {
    const row = { id: CONNECTOR_ID };
    const safe = vi.fn().mockReturnValue({ id: CONNECTOR_ID, tokenLast4: 'abcd' });
    const get = vi.fn().mockResolvedValue(row);
    container.registerInstance(HostingConnectorsService, { get, safe } as unknown as HostingConnectorsService);
    const catalog = vi.fn().mockResolvedValue({ plans: [] });
    container.registerInstance(HostingProvisioningService, { catalog } as unknown as HostingProvisioningService);

    await expect(
      executeHostingTool(USER, 'manage_hosting', { operation: 'connector_get', connectorId: CONNECTOR_ID })
    ).resolves.toEqual({ id: CONNECTOR_ID, tokenLast4: 'abcd' });
    expect(get).toHaveBeenCalledWith(CONNECTOR_ID, USER);
    expect(safe).toHaveBeenCalledWith(row);

    await executeHostingTool(USER, 'manage_hosting', { operation: 'catalog', connectorId: CONNECTOR_ID });
    expect(catalog).toHaveBeenCalledWith(CONNECTOR_ID, USER);
  });
});
