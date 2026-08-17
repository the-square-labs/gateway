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

function createService(templatesService: Record<string, unknown>) {
  const service = new AIService(
    {} as never,
    {} as never,
    {} as never,
    templatesService as never,
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
  (service as any).licensePolicyService = { requireFeature: vi.fn().mockResolvedValue(undefined) };
  return service;
}

describe('AIService PKI template tool routing', () => {
  it('routes template list/create/delete operations through the templates service', async () => {
    const templatesService = {
      listTemplates: vi.fn().mockResolvedValue([{ id: 'template-1' }]),
      createTemplate: vi.fn().mockResolvedValue({ id: 'template-2', name: 'Web TLS' }),
      deleteTemplate: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService(templatesService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pki:templates:view'] }, 'list_templates', {})
    ).resolves.toEqual({ result: [{ id: 'template-1' }], invalidateStores: [] });
    expect(templatesService.listTemplates).toHaveBeenCalledWith();

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pki:templates:create'] }, 'create_template', {
        name: 'Web TLS',
        type: 'tls-server',
        keyAlgorithm: 'ecdsa-p256',
        validityDays: 90,
        keyUsage: ['digitalSignature'],
        extendedKeyUsage: ['serverAuth'],
      })
    ).resolves.toEqual({ result: { id: 'template-2', name: 'Web TLS' }, invalidateStores: ['templates'] });
    expect(templatesService.createTemplate).toHaveBeenCalledWith(
      {
        name: 'Web TLS',
        certType: 'tls-server',
        keyAlgorithm: 'ecdsa-p256',
        validityDays: 90,
        keyUsage: ['digitalSignature'],
        extKeyUsage: ['serverAuth'],
        requireSans: true,
        sanTypes: ['dns'],
        crlDistributionPoints: [],
        certificatePolicies: [],
        customExtensions: [],
      },
      'user-1'
    );

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pki:templates:delete:template-1'] }, 'delete_template', {
        templateId: 'template-1',
      })
    ).resolves.toEqual({ result: { success: true }, invalidateStores: ['templates'] });
    expect(templatesService.deleteTemplate).toHaveBeenCalledWith('template-1');
  });

  it('routes managed template get/update operations with resource scopes', async () => {
    const templatesService = {
      getTemplate: vi.fn().mockResolvedValue({ id: 'template-1', name: 'old' }),
      updateTemplate: vi.fn().mockResolvedValue({ id: 'template-1', name: 'new' }),
    };
    const service = createService(templatesService);

    await expect(
      service.executeTool(
        { ...BASE_USER, scopes: ['pki:templates:view', 'pki:templates:view:template-1'] },
        'manage_template',
        {
          operation: 'get',
          templateId: 'template-1',
        }
      )
    ).resolves.toEqual({ result: { id: 'template-1', name: 'old' }, invalidateStores: ['templates'] });
    expect(templatesService.getTemplate).toHaveBeenCalledWith('template-1');

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pki:templates:view', 'pki:templates:edit'] }, 'manage_template', {
        operation: 'update',
        templateId: 'template-1',
        name: 'new',
        type: 'tls-client',
        keyAlgorithm: 'rsa-2048',
        validityDays: 180,
        keyUsage: ['keyEncipherment'],
        extendedKeyUsage: ['clientAuth'],
      })
    ).resolves.toEqual({ result: { id: 'template-1', name: 'new' }, invalidateStores: ['templates'] });
    expect(templatesService.updateTemplate).toHaveBeenCalledWith('template-1', {
      name: 'new',
      certType: 'tls-client',
      keyAlgorithm: 'rsa-2048',
      validityDays: 180,
      keyUsage: ['keyEncipherment'],
      extKeyUsage: ['clientAuth'],
    });
  });
});
