import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { CommercialEditionRuntime } from '@/edition/runtime.js';
import { ExportService } from '@/modules/pki/export.service.js';
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

beforeEach(() => {
  container.registerInstance(TOKENS.CommercialEdition, { requireAvailable: vi.fn() });
});
afterEach(() => {
  container.reset();
});

function createService(caService: Record<string, unknown>) {
  const service = new AIService(
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
  (service as any).licensePolicyService = { requireFeature: vi.fn().mockResolvedValue(undefined) };
  return service;
}

describe('AIService PKI CA tool routing', () => {
  it('does not expose user PKI through MCP when an entitled license has no private module', async () => {
    container.registerInstance(TOKENS.CommercialEdition, CommercialEditionRuntime.community());
    const caService = { getCATree: vi.fn() };
    await expect(
      createService(caService).executeTool({ ...BASE_USER, scopes: ['pki:ca:view:root'] }, 'list_cas', {})
    ).resolves.toMatchObject({ error: expect.stringContaining('commercial module') });
    expect(caService.getCATree).not.toHaveBeenCalled();
  });
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
    expect(caService.getCATree).toHaveBeenCalledWith(false);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pki:ca:view:root'] }, 'get_ca', { caId: 'root-ca' })
    ).resolves.toEqual({ result: { id: 'root-ca', type: 'root' }, invalidateStores: [] });
    expect(caService.getCA).toHaveBeenCalledWith('root-ca', { includeSystem: false });

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

  it('lists issuable CAs and system CAs with the same rules as GET /cas', async () => {
    const caService = {
      getCATree: vi.fn().mockResolvedValue([
        { id: 'root-ca', type: 'root' },
        { id: 'issuing-ca', type: 'intermediate' },
      ]),
    };
    const service = createService(caService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pki:cert:issue:issuing-ca'] }, 'list_cas', {})
    ).resolves.toEqual({ result: [{ id: 'issuing-ca', type: 'intermediate' }], invalidateStores: [] });
    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pki:ca:view:root'] }, 'list_cas', { showSystem: true })
    ).resolves.toEqual({ error: 'Missing required scope: admin:details:certificates', invalidateStores: [] });
    await service.executeTool(
      { ...BASE_USER, scopes: ['pki:ca:view:root', 'admin:details:certificates'] },
      'list_cas',
      { showSystem: true }
    );
    expect(caService.getCATree).toHaveBeenLastCalledWith(true);
  });

  it('revokes, exports, and updates CAs with the route scopes', async () => {
    const audit = { log: vi.fn().mockResolvedValue(true) };
    const exportCAKey = vi.fn().mockResolvedValue(Buffer.from('p12'));
    const caService = {
      getCA: vi.fn().mockResolvedValue({ id: 'root-ca', type: 'root' }),
      revokeCA: vi.fn().mockResolvedValue(undefined),
      updateCA: vi.fn().mockResolvedValue({ id: 'int-ca' }),
      getCASigningMaterials: vi.fn().mockResolvedValue({
        ca: { commonName: 'Root CA', certificatePem: 'CERT' },
        privateKeyPem: 'KEY',
      }),
    };
    const service = createService(caService);
    (service as any).auditService = audit;
    container.registerInstance(ExportService, { exportCAKey } as never);

    // PUT /cas/{id} requires pki:ca:create:root regardless of the CA type.
    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pki:ca:create:intermediate'] }, 'manage_ca', {
        operation: 'update',
        caId: 'int-ca',
        maxValidityDays: 30,
      })
    ).resolves.toEqual({
      error: 'PERMISSION_DENIED: Missing required scope pki:ca:create:root',
      invalidateStores: [],
    });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pki:ca:revoke:intermediate'] }, 'manage_ca', {
        operation: 'revoke',
        caId: 'root-ca',
        reason: 'compromised',
      })
    ).resolves.toEqual({
      error: 'PERMISSION_DENIED: Missing required scope pki:ca:revoke:root',
      invalidateStores: [],
    });
    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pki:ca:revoke:root'] }, 'manage_ca', {
        operation: 'revoke',
        caId: 'root-ca',
        reason: 'compromised',
      })
    ).resolves.toMatchObject({ result: { success: true } });
    expect(caService.revokeCA).toHaveBeenCalledWith('root-ca', 'compromised', 'user-1');

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pki:ca:create:root'] }, 'manage_ca', {
        operation: 'export_key',
        caId: 'root-ca',
        passphrase: 'short',
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('passphrase') });
    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pki:ca:create:root'] }, 'manage_ca', {
        operation: 'export_key',
        caId: 'root-ca',
        passphrase: 'long-enough-passphrase',
      })
    ).resolves.toMatchObject({
      result: { format: 'pkcs12', filename: 'Root_CA.p12', contentBase64: Buffer.from('p12').toString('base64') },
    });
    expect(exportCAKey).toHaveBeenCalledWith('KEY', 'CERT', 'long-enough-passphrase');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ca.export_key', resourceType: 'ca', resourceId: 'root-ca' })
    );
  });
});
