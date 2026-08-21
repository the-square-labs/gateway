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

function mockContainerResolve(services: Record<string, unknown>) {
  return vi.spyOn(container, 'resolve').mockImplementation((token: unknown) => {
    const name = typeof token === 'function' ? token.name : String(token);
    const service = services[name];
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
    mockContainerResolve({ LoggingSchemaService: loggingSchemaService });
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
});
