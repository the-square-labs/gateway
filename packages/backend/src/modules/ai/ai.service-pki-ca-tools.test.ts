import { describe, expect, it, vi } from 'vitest';
import { AIService } from './ai.service.js';

const BASE_USER = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: [] as string[],
  isBlocked: false,
};

function createService(caService: Record<string, unknown>) {
  return new AIService(
    {} as never,
    caService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { log: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
}

describe('AIService PKI CA tool routing', () => {
  it('checks the Enterprise PKI entitlement before invoking a PKI tool', async () => {
    const caService = { getCATree: vi.fn() };
    const service = createService(caService);
    const error = new Error('license denied');
    const policy = { requireFeature: vi.fn().mockRejectedValue(error) };
    (service as unknown as { licensePolicyService: typeof policy }).licensePolicyService = policy;

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pki:ca:view:root'] }, 'list_cas', {})
    ).resolves.toMatchObject({ error: 'license denied' });
    expect(policy.requireFeature).toHaveBeenCalledWith('internal-pki');
    expect(caService.getCATree).not.toHaveBeenCalled();
  });

  it('routes CA list/get/create operations through the CA service with type-specific scopes', async () => {
    const caService = {
      getCATree: vi.fn().mockResolvedValue([
        { id: 'root-ca', type: 'root' },
        { id: 'intermediate-ca', type: 'intermediate' },
      ]),
      getCA: vi.fn().mockResolvedValue({ id: 'root-ca', type: 'root' }),
      createRootCA: vi.fn().mockResolvedValue({ id: 'new-root-ca' }),
      createIntermediateCA: vi.fn().mockResolvedValue({ id: 'new-intermediate-ca' }),
    };
    const service = createService(caService);

    await expect(service.executeTool({ ...BASE_USER, scopes: ['pki:ca:view:root'] }, 'list_cas', {})).resolves.toEqual({
      result: [{ id: 'root-ca', type: 'root' }],
      invalidateStores: [],
    });
    expect(caService.getCATree).toHaveBeenCalledWith();

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pki:ca:view:root'] }, 'get_ca', { caId: 'root-ca' })
    ).resolves.toEqual({ result: { id: 'root-ca', type: 'root' }, invalidateStores: [] });
    expect(caService.getCA).toHaveBeenCalledWith('root-ca');

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pki:ca:create:root'] }, 'create_root_ca', {
        commonName: 'Root CA',
        keyAlgorithm: 'ecdsa-p256',
        validityYears: 10,
        maxValidityDays: 825,
      })
    ).resolves.toEqual({ result: { id: 'new-root-ca' }, invalidateStores: ['ca'] });
    expect(caService.createRootCA).toHaveBeenCalledWith(
      {
        commonName: 'Root CA',
        keyAlgorithm: 'ecdsa-p256',
        validityYears: 10,
        maxValidityDays: 825,
      },
      'user-1'
    );

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pki:ca:create:intermediate'] }, 'create_intermediate_ca', {
        parentCaId: 'root-ca',
        commonName: 'Intermediate CA',
        keyAlgorithm: 'rsa-2048',
        validityYears: 5,
        maxValidityDays: 365,
      })
    ).resolves.toEqual({ result: { id: 'new-intermediate-ca' }, invalidateStores: ['ca'] });
    expect(caService.createIntermediateCA).toHaveBeenCalledWith(
      'root-ca',
      {
        commonName: 'Intermediate CA',
        keyAlgorithm: 'rsa-2048',
        validityYears: 5,
        maxValidityDays: 365,
      },
      'user-1'
    );
  });

  it('routes CA delete/update operations with type-specific authorization', async () => {
    const caService = {
      getCA: vi
        .fn()
        .mockResolvedValueOnce({ id: 'intermediate-ca', type: 'intermediate' })
        .mockResolvedValueOnce({ id: 'root-ca', type: 'root' }),
      deleteCA: vi.fn().mockResolvedValue(undefined),
      updateCA: vi.fn().mockResolvedValue({ id: 'root-ca', maxValidityDays: 365 }),
    };
    const service = createService(caService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pki:ca:revoke:intermediate'] }, 'delete_ca', {
        caId: 'intermediate-ca',
      })
    ).resolves.toEqual({ result: { success: true }, invalidateStores: ['ca'] });
    expect(caService.deleteCA).toHaveBeenCalledWith('intermediate-ca', 'user-1');

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pki:ca:create:root'] }, 'manage_ca', {
        operation: 'update',
        caId: 'root-ca',
        crlDistributionUrl: null,
        caIssuersUrl: 'https://ca.example.com/issuer.pem',
        maxValidityDays: 365,
      })
    ).resolves.toEqual({ result: { id: 'root-ca', maxValidityDays: 365 }, invalidateStores: ['ca'] });
    expect(caService.updateCA).toHaveBeenCalledWith(
      'root-ca',
      {
        crlDistributionUrl: null,
        caIssuersUrl: 'https://ca.example.com/issuer.pem',
        maxValidityDays: 365,
      },
      'user-1'
    );
  });
});
