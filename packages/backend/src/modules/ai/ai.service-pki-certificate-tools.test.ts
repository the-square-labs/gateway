import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exportService: {
    exportDER: vi.fn(),
    exportPKCS12: vi.fn(),
    exportJKS: vi.fn(),
  },
  systemCertificateLifecycle: { auditSystemLeaves: vi.fn() },
  edition: { requireAvailable: vi.fn() },
}));

vi.mock('@/container.js', () => ({
  container: {
    isRegistered: vi.fn((token) => token === Symbol.for('CommercialEdition')),
    resolve: vi.fn((token) =>
      token === Symbol.for('CommercialEdition')
        ? mocks.edition
        : token?.name === 'SystemCertificateLifecycleService'
          ? mocks.systemCertificateLifecycle
          : mocks.exportService
    ),
  },
  TOKENS: {
    DrizzleClient: Symbol.for('DrizzleClient'),
    CommercialEdition: Symbol.for('CommercialEdition'),
  },
}));

import { AIService } from './ai.service.js';

const CERT_ID = '11111111-1111-4111-8111-111111111111';
const CA_ID = '22222222-2222-4222-8222-222222222222';
const PARENT_CA_ID = '33333333-3333-4333-8333-333333333333';

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

function createService(caService: Record<string, unknown>, certService: Record<string, unknown>) {
  const service = new AIService(
    {} as never,
    caService as never,
    certService as never,
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

describe('AIService PKI certificate tool routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exportService.exportDER.mockReturnValue(Buffer.from('der-bytes'));
    mocks.exportService.exportPKCS12.mockReturnValue(Buffer.from('pkcs12-bytes'));
    mocks.exportService.exportJKS.mockReturnValue(Buffer.from('jks-bytes'));
    mocks.systemCertificateLifecycle.auditSystemLeaves.mockResolvedValue({ summary: { total: 0 } });
  });

  it('routes certificate list/get/issue/revoke operations through the certificate service', async () => {
    const caService = {};
    const certService = {
      listCertificates: vi.fn().mockResolvedValue({ data: [{ id: CERT_ID }], total: 1 }),
      getCertificate: vi.fn().mockResolvedValue({ id: CERT_ID, certificatePem: 'CERT_PEM' }),
      issueCertificate: vi.fn().mockResolvedValue({ certificate: { id: CERT_ID } }),
      revokeCertificate: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService(caService, certService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pki:cert:view'] }, 'list_certificates', {
        caId: CA_ID,
        status: 'active',
        search: 'example',
        page: 2,
        limit: 25,
      })
    ).resolves.toEqual({ result: { data: [{ id: CERT_ID }], total: 1 }, invalidateStores: [] });
    expect(certService.listCertificates).toHaveBeenCalledWith(
      {
        caId: CA_ID,
        status: 'active',
        search: 'example',
        page: 2,
        limit: 25,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      },
      { allowedIds: undefined }
    );

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`pki:cert:view:${CERT_ID}`] }, 'get_certificate', {
        certificateId: CERT_ID,
      })
    ).resolves.toEqual({ result: { id: CERT_ID, certificatePem: 'CERT_PEM' }, invalidateStores: [] });
    expect(certService.getCertificate).toHaveBeenCalledWith(CERT_ID, { includeSystem: false });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pki:cert:issue'] }, 'issue_certificate', {
        caId: CA_ID,
        commonName: 'api.example.com',
        keyAlgorithm: 'ecdsa-p256',
        validityDays: 90,
        type: 'tls-server',
        sans: ['api.example.com'],
      })
    ).resolves.toEqual({
      result: {
        certificate: { id: CERT_ID },
        message: expect.stringContaining('Private key was generated'),
      },
      invalidateStores: ['certificates', 'ca'],
    });
    expect(certService.issueCertificate).toHaveBeenCalledWith(
      {
        caId: CA_ID,
        commonName: 'api.example.com',
        keyAlgorithm: 'ecdsa-p256',
        validityDays: 90,
        type: 'tls-server',
        sans: ['api.example.com'],
      },
      'user-1'
    );

    // The reason is validated with the revoke route schema.
    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`pki:cert:revoke:${CERT_ID}`] }, 'revoke_certificate', {
        certificateId: CERT_ID,
        reason: 'key_compromise',
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('reason') });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`pki:cert:revoke:${CERT_ID}`] }, 'revoke_certificate', {
        certificateId: CERT_ID,
        reason: 'keyCompromise',
      })
    ).resolves.toEqual({
      result: { success: true, message: 'Certificate revoked.' },
      invalidateStores: ['certificates', 'ca'],
    });
    expect(certService.revokeCertificate).toHaveBeenCalledWith(CERT_ID, 'keyCompromise', 'user-1');
  });

  it('allows the explicit system audit only with both PKI view and system-details permission', async () => {
    const service = createService({}, {});
    const policy = (service as any).licensePolicyService;

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pki:cert:view'] }, 'audit_system_pki_leaves', {})
    ).resolves.toMatchObject({ error: expect.stringContaining('admin:details:certificates') });
    await expect(
      service.executeTool(
        { ...BASE_USER, scopes: ['pki:cert:view', 'admin:details:certificates'] },
        'audit_system_pki_leaves',
        { caId: CA_ID }
      )
    ).resolves.toEqual({ result: { summary: { total: 0 } }, invalidateStores: [] });
    expect(mocks.systemCertificateLifecycle.auditSystemLeaves).toHaveBeenCalledWith(CA_ID);
    expect(policy.requireFeature).not.toHaveBeenCalled();
  });

  it('routes managed certificate CSR, chain, and export operations with operation-specific scopes', async () => {
    const caService = {
      getCA: vi
        .fn()
        .mockResolvedValueOnce({ id: CA_ID, parentId: PARENT_CA_ID, certificatePem: 'CA_PEM' })
        .mockResolvedValueOnce({ id: PARENT_CA_ID, parentId: null, certificatePem: 'PARENT_CA_PEM' }),
    };
    const certService = {
      issueCertificateFromCSR: vi.fn().mockResolvedValue({ id: 'csr-cert' }),
      getCertificate: vi
        .fn()
        .mockResolvedValueOnce({ id: CERT_ID, caId: CA_ID, certificatePem: 'CERT_PEM' })
        .mockResolvedValueOnce({ id: CERT_ID, certificatePem: 'EXPORT_CERT_PEM', commonName: 'api.example.com' }),
      getCertificatePrivateKey: vi.fn().mockResolvedValue('PRIVATE_KEY_PEM'),
    };
    const service = createService(caService, certService);

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['pki:cert:issue'] }, 'manage_certificate', {
        operation: 'issue_from_csr',
        caId: CA_ID,
        type: 'tls-server',
        csrPem: 'CSR_PEM',
        validityDays: 30,
        overrideSans: ['api.example.com'],
      })
    ).resolves.toEqual({ result: { id: 'csr-cert' }, invalidateStores: ['certificates', 'ca'] });
    expect(certService.issueCertificateFromCSR).toHaveBeenCalledWith(
      {
        caId: CA_ID,
        type: 'tls-server',
        csrPem: 'CSR_PEM',
        validityDays: 30,
        overrideSans: ['api.example.com'],
      },
      'user-1'
    );

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`pki:cert:view:${CERT_ID}`] }, 'manage_certificate', {
        operation: 'chain',
        certificateId: CERT_ID,
      })
    ).resolves.toEqual({
      result: {
        certificatePem: 'CERT_PEM',
        chainPem: 'CERT_PEM\nCA_PEM\nPARENT_CA_PEM',
      },
      invalidateStores: ['certificates', 'ca'],
    });
    expect(caService.getCA).toHaveBeenNthCalledWith(1, CA_ID, { includeSystem: false });
    expect(caService.getCA).toHaveBeenNthCalledWith(2, PARENT_CA_ID, { includeSystem: false });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`pki:cert:export:${CERT_ID}`] }, 'manage_certificate', {
        operation: 'export',
        certificateId: CERT_ID,
        format: 'der',
      })
    ).resolves.toEqual({
      result: {
        format: 'der',
        filename: 'api.example.com.der',
        contentBase64: Buffer.from('der-bytes').toString('base64'),
      },
      invalidateStores: ['certificates', 'ca'],
    });
    expect(mocks.exportService.exportDER).toHaveBeenCalledWith('EXPORT_CERT_PEM');
    expect(certService.getCertificatePrivateKey).not.toHaveBeenCalled();
  });

  it('issues from CSR with a per-CA grant like POST /certificates/from-csr', async () => {
    const certService = { issueCertificateFromCSR: vi.fn().mockResolvedValue({ id: 'csr-cert' }) };
    const service = createService({}, certService);
    const args = { operation: 'issue_from_csr', caId: CA_ID, type: 'tls-server', csrPem: 'CSR', validityDays: 30 };

    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`pki:cert:issue:${PARENT_CA_ID}`] }, 'manage_certificate', args)
    ).resolves.toEqual({ error: `Missing required scope: pki:cert:issue:${CA_ID}`, invalidateStores: [] });
    await expect(
      service.executeTool({ ...BASE_USER, scopes: [`pki:cert:issue:${CA_ID}`] }, 'manage_certificate', args)
    ).resolves.toEqual({ result: { id: 'csr-cert' }, invalidateStores: ['certificates', 'ca'] });
  });

  it('exports private keys only with an audit record and never from system CAs without admin:system', async () => {
    const audit = { log: vi.fn().mockResolvedValue(true) };
    const caService = {
      getCA: vi.fn(async (id: string) =>
        id === CA_ID
          ? { id: CA_ID, type: 'intermediate', isSystem: false, parentId: PARENT_CA_ID, certificatePem: 'INT_PEM' }
          : { id: PARENT_CA_ID, type: 'root', isSystem: false, parentId: null, certificatePem: 'ROOT_PEM' }
      ),
    };
    const certService = {
      getCertificate: vi.fn().mockResolvedValue({
        id: CERT_ID,
        caId: CA_ID,
        commonName: 'api.example.com',
        certificatePem: 'CERT_PEM',
      }),
      getCertificatePrivateKey: vi.fn().mockResolvedValue('PRIVATE_KEY_PEM'),
    };
    const service = createService(caService, certService);
    (service as any).auditService = audit;
    const exportAs = (format: string, extra: Record<string, unknown> = {}) =>
      service.executeTool({ ...BASE_USER, scopes: [`pki:cert:export:${CERT_ID}`] }, 'manage_certificate', {
        operation: 'export',
        certificateId: CERT_ID,
        format,
        ...extra,
      });

    await expect(exportAs('private-key')).resolves.toMatchObject({
      result: { format: 'private-key', filename: 'api.example.com-private-key.pem', content: 'PRIVATE_KEY_PEM' },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cert.export_key', resourceId: CERT_ID, details: { format: 'private-key' } })
    );

    // PKCS#12 carries the intermediate chain, like the route.
    await expect(exportAs('pkcs12', { passphrase: 'secret-pass' })).resolves.toMatchObject({
      result: { format: 'pkcs12' },
    });
    expect(mocks.exportService.exportPKCS12).toHaveBeenCalledWith('CERT_PEM', 'PRIVATE_KEY_PEM', 'secret-pass', [
      'INT_PEM',
    ]);

    // No audit record, no key.
    audit.log.mockResolvedValueOnce(false);
    await expect(exportAs('private-key')).resolves.toEqual({
      error: 'Private key export requires an audit record',
      invalidateStores: [],
    });

    caService.getCA.mockResolvedValueOnce({
      id: CA_ID,
      type: 'intermediate',
      isSystem: true,
      parentId: null,
      certificatePem: 'SYS_PEM',
    });
    await expect(exportAs('private-key')).resolves.toEqual({
      error: 'System certificate private keys cannot be exported',
      invalidateStores: [],
    });
  });
});
