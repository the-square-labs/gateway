import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
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

function createService() {
  return new AIService(
    {} as never,
    {} as never,
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

const licensePolicyService = { requireFeature: vi.fn(), requireFeatureForExistingRuntime: vi.fn() };
const enabledLoggingFeature = { requireEnabled: vi.fn(), requireAvailableForStorage: vi.fn() };

function mockContainerResolve(services: Record<string, unknown>) {
  const withLoggingGate: Record<string, unknown> = {
    LicensePolicyService: licensePolicyService,
    LoggingFeatureService: enabledLoggingFeature,
    ...services,
  };
  return vi.spyOn(container, 'resolve').mockImplementation((token: unknown) => {
    const name = typeof token === 'function' ? token.name : String(token);
    const service = withLoggingGate[name];
    if (!service) throw new Error(`Unexpected service resolve: ${name}`);
    return service as never;
  });
}

describe('AIService logging tool routing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists logging environments with direct resource-scoped allowed ids', async () => {
    const loggingEnvironmentService = {
      list: vi.fn().mockResolvedValue([{ id: 'env-1' }]),
    };
    mockContainerResolve({ LoggingEnvironmentService: loggingEnvironmentService });
    const service = createService();

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['logs:environments:view:env-1'] }, 'manage_logging', {
        resource: 'environment',
        operation: 'list',
        search: 'prod',
      })
    ).resolves.toMatchObject({
      result: [{ id: 'env-1' }],
      invalidateStores: [],
    });
    expect(loggingEnvironmentService.list).toHaveBeenCalledWith({
      search: 'prod',
      allowedIds: ['env-1'],
    });
  });

  it('filters schema lists when only resource-scoped schema view grants are present', async () => {
    const loggingSchemaService = {
      list: vi.fn().mockResolvedValue([{ id: 'schema-1' }, { id: 'schema-2' }]),
    };
    mockContainerResolve({ LoggingSchemaService: loggingSchemaService });
    const service = createService();

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['logs:schemas:view:schema-2'] }, 'manage_logging', {
        resource: 'schema',
        operation: 'list',
        search: 'errors',
      })
    ).resolves.toMatchObject({
      result: [{ id: 'schema-2' }],
      invalidateStores: [],
    });
    expect(loggingSchemaService.list).toHaveBeenCalledWith({ search: 'errors' });
  });

  it('accepts plural and dotted logging schema operation aliases', async () => {
    const loggingSchemaService = {
      create: vi.fn().mockResolvedValueOnce({ id: 'schema-1' }).mockResolvedValueOnce({ id: 'schema-2' }),
    };
    mockContainerResolve({
      LoggingSchemaService: loggingSchemaService,
      LoggingSchemaFolderService: { assertFolderExists: vi.fn() },
    });
    const service = createService();

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['logs:schemas:create'] }, 'manage_logging', {
        resource: 'schemas',
        operation: 'create',
        payload: { name: 'App Logs', slug: 'app-logs', schemaMode: 'loose', fieldSchema: [] },
      })
    ).resolves.toMatchObject({
      result: { id: 'schema-1' },
      invalidateStores: ['logging'],
    });

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['logs:schemas:create'] }, 'manage_logging', {
        operation: 'schemas.create',
        payload: { name: 'Audit Logs', slug: 'audit-logs', schemaMode: 'reject', fieldSchema: [] },
      })
    ).resolves.toMatchObject({
      result: { id: 'schema-2' },
      invalidateStores: ['logging'],
    });

    expect(loggingSchemaService.create).toHaveBeenNthCalledWith(
      1,
      { name: 'App Logs', schemaMode: 'loose', fieldSchema: [] },
      'user-1'
    );
    expect(loggingSchemaService.create).toHaveBeenNthCalledWith(
      2,
      { name: 'Audit Logs', schemaMode: 'reject', fieldSchema: [] },
      'user-1'
    );
  });

  it('creates logging tokens with parsed payloads and environment-scoped permissions', async () => {
    const loggingTokenService = {
      create: vi.fn().mockResolvedValue({ id: 'token-1' }),
    };
    mockContainerResolve({ LoggingTokenService: loggingTokenService });
    const service = createService();

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['logs:tokens:create:env-1'] }, 'manage_logging', {
        resource: 'token',
        operation: 'create',
        environmentId: 'env-1',
        payload: { name: 'ingest', expiresAt: null },
      })
    ).resolves.toMatchObject({
      result: { id: 'token-1' },
      invalidateStores: ['loggingTokens'],
    });
    expect(loggingTokenService.create).toHaveBeenCalledWith('env-1', { name: 'ingest', expiresAt: null }, 'user-1');
  });

  it('requires logging storage before running log searches', async () => {
    const loggingFeatureService = {
      requireEnabled: vi.fn(),
      requireAvailableForStorage: vi.fn(),
    };
    const loggingSearchService = {
      search: vi.fn().mockResolvedValue({ data: [] }),
    };
    mockContainerResolve({
      LoggingFeatureService: loggingFeatureService,
      LoggingSearchService: loggingSearchService,
    });
    const service = createService();

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['logs:read:env-1'] }, 'manage_logging', {
        resource: 'logs',
        operation: 'search',
        environmentId: 'env-1',
        payload: { message: 'error', limit: 10 },
      })
    ).resolves.toMatchObject({
      result: { data: [] },
      invalidateStores: [],
    });
    expect(loggingFeatureService.requireAvailableForStorage).toHaveBeenCalled();
    expect(loggingSearchService.search).toHaveBeenCalledWith('env-1', { message: 'error', limit: 10 });
  });

  it('applies the structured-logging license and enabled gate like the logging routes', async () => {
    const loggingEnvironmentService = { get: vi.fn().mockResolvedValue({ id: 'env-1' }) };
    const disabledFeature = {
      requireEnabled: vi.fn(() => {
        throw new Error('LOGGING_DISABLED');
      }),
    };
    mockContainerResolve({
      LoggingEnvironmentService: loggingEnvironmentService,
      LoggingFeatureService: disabledFeature,
    });
    const service = createService();

    const result = await service.executeTool({ ...BASE_USER, scopes: ['logs:environments:view'] }, 'manage_logging', {
      resource: 'environment',
      operation: 'get',
      environmentId: 'env-1',
    });
    expect(result).toHaveProperty('error');
    // Reading an existing environment uses continuity after the license grace period.
    expect(licensePolicyService.requireFeatureForExistingRuntime).toHaveBeenCalledWith('structured-logging');
    expect(loggingEnvironmentService.get).not.toHaveBeenCalled();
  });

  it('authorizes environment creation against the destination folder like the create route', async () => {
    const folderId = '11111111-1111-4111-8111-111111111111';
    const otherFolderId = '22222222-2222-4222-8222-222222222222';
    const loggingEnvironmentService = { create: vi.fn().mockResolvedValue({ id: 'env-1' }) };
    const folders = { assertFolderExists: vi.fn() };
    mockContainerResolve({
      LoggingEnvironmentService: loggingEnvironmentService,
      LoggingEnvironmentFolderService: folders,
    });
    const service = createService();
    const creator = { ...BASE_USER, scopes: [`logs:environments:create:folder/${folderId}`] };
    const payload = { name: 'App', schemaMode: 'loose', retentionDays: 7, fieldSchema: [] };

    const denied = await service.executeTool(creator, 'manage_logging', {
      resource: 'environment',
      operation: 'create',
      payload: { ...payload, folderId: otherFolderId },
    });
    expect(denied).toHaveProperty('error');
    expect(loggingEnvironmentService.create).not.toHaveBeenCalled();

    await expect(
      service.executeTool(creator, 'manage_logging', {
        resource: 'environment',
        operation: 'create',
        payload: { ...payload, folderId },
      })
    ).resolves.toMatchObject({ result: { id: 'env-1' } });
    expect(folders.assertFolderExists).toHaveBeenCalledWith(folderId);
    expect(loggingEnvironmentService.create).toHaveBeenCalledWith(expect.objectContaining({ folderId }), 'user-1');
  });

  it('reads logging health with housekeeping:view outside the logging license gate', async () => {
    const maintenance = { getSnapshot: vi.fn().mockReturnValue({ status: 'healthy' }) };
    licensePolicyService.requireFeature.mockClear();
    licensePolicyService.requireFeatureForExistingRuntime.mockClear();
    mockContainerResolve({ LoggingMaintenanceService: maintenance });
    const service = createService();

    await expect(
      service.executeTool({ ...BASE_USER, scopes: ['housekeeping:view'] }, 'manage_logging', {
        resource: 'health',
        operation: 'get',
      })
    ).resolves.toMatchObject({ result: { status: 'healthy' } });
    const denied = await service.executeTool({ ...BASE_USER, scopes: ['databases:view'] }, 'manage_logging', {
      resource: 'health',
      operation: 'get',
    });
    expect(denied).toHaveProperty('error');
    expect(maintenance.getSnapshot).toHaveBeenCalledTimes(1);
    expect(licensePolicyService.requireFeature).not.toHaveBeenCalled();
    expect(licensePolicyService.requireFeatureForExistingRuntime).not.toHaveBeenCalled();
  });
});

describe('AIService logging tool list and schema rules', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists environments and schemas as empty for a creator, like the REST lists', async () => {
    const loggingEnvironmentService = { list: vi.fn().mockResolvedValue([]) };
    const loggingSchemaService = { list: vi.fn().mockResolvedValue([{ id: 'schema-1' }]) };
    mockContainerResolve({
      LoggingEnvironmentService: loggingEnvironmentService,
      LoggingSchemaService: loggingSchemaService,
    });
    const service = createService();
    const creator = {
      ...BASE_USER,
      scopes: ['logs:environments:create:folder/folder-1', 'logs:schemas:create:folder/folder-1'],
    };

    await expect(
      service.executeTool(creator, 'manage_logging', { resource: 'environment', operation: 'list' })
    ).resolves.toMatchObject({ result: [] });
    expect(loggingEnvironmentService.list).toHaveBeenCalledWith({ search: undefined, allowedIds: [] });
    await expect(
      service.executeTool(creator, 'manage_logging', { resource: 'schema', operation: 'list' })
    ).resolves.toMatchObject({ result: [] });
  });

  it('refuses to attach a schema the caller cannot view', async () => {
    const schemaId = '22222222-2222-4222-8222-222222222222';
    const loggingEnvironmentService = {
      create: vi.fn().mockResolvedValue({ id: 'env-1' }),
      get: vi.fn().mockResolvedValue({ id: 'env-1', schemaId: null }),
      update: vi.fn().mockResolvedValue({ id: 'env-1' }),
    };
    mockContainerResolve({
      LoggingEnvironmentService: loggingEnvironmentService,
      LoggingEnvironmentFolderService: { assertFolderExists: vi.fn() },
    });
    const service = createService();
    const editor = { ...BASE_USER, scopes: ['logs:environments:create', 'logs:environments:edit'] };

    const created = await service.executeTool(editor, 'manage_logging', {
      resource: 'environment',
      operation: 'create',
      payload: { name: 'Production', schemaId },
    });
    expect(created).toMatchObject({ error: expect.stringContaining(`logs:schemas:view:${schemaId}`) });
    const updated = await service.executeTool(editor, 'manage_logging', {
      resource: 'environment',
      operation: 'update',
      environmentId: 'env-1',
      payload: { schemaId },
    });
    expect(updated).toMatchObject({ error: expect.stringContaining(`logs:schemas:view:${schemaId}`) });
    expect(loggingEnvironmentService.create).not.toHaveBeenCalled();
    expect(loggingEnvironmentService.update).not.toHaveBeenCalled();

    await expect(
      service.executeTool(
        { ...editor, scopes: [...editor.scopes, `logs:schemas:view:${schemaId}`] },
        'manage_logging',
        {
          resource: 'environment',
          operation: 'create',
          payload: { name: 'Production', schemaId },
        }
      )
    ).resolves.toMatchObject({ result: { id: 'env-1' } });
  });
});
