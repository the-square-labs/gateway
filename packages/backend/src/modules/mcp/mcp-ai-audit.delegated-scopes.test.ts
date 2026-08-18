import { describe, expect, it, vi } from 'vitest';
import {
  AIService,
  container,
  createService,
  DockerDeploymentService,
  LoggingEnvironmentService,
  LoggingSchemaService,
  USER,
} from './mcp-ai-audit.test-helpers.js';

describe('AIService MCP delegated scope audit behavior', () => {
  it('rechecks live account access without expanding an OAuth token scope', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const nodesService = { create: vi.fn() };
    const service = createService({
      nodesService,
      auditService,
      authService: { getUserById: vi.fn().mockResolvedValue({ ...USER, scopes: ['nodes:details'] }) },
    });

    const revoked = await service.executeTool(
      USER,
      'create_node',
      { hostname: 'node-1', type: 'docker' },
      { source: 'mcp', scopes: ['nodes:create'] }
    );
    expect(revoked.error).toContain('PERMISSION_DENIED');
    expect(nodesService.create).not.toHaveBeenCalled();

    const tokenBoundService = createService({
      nodesService,
      auditService,
      authService: { getUserById: vi.fn().mockResolvedValue({ ...USER, scopes: ['nodes:create', 'nodes:details'] }) },
    });
    const stillBound = await tokenBoundService.executeTool(
      { ...USER, scopes: ['nodes:create', 'nodes:details'] },
      'create_node',
      { hostname: 'node-1', type: 'docker' },
      { source: 'mcp', scopes: ['nodes:details'] }
    );
    expect(stillBound.error).toContain('PERMISSION_DENIED');
    expect(nodesService.create).not.toHaveBeenCalled();
  });

  it('filters find_resource logging matches to delegated resource-scoped grants', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const envList = vi.fn().mockResolvedValue([{ id: 'env-1', name: 'prod logs', slug: 'prod' }]);
    const schemaList = vi.fn().mockResolvedValue([
      { id: 'schema-1', name: 'prod schema', slug: 'prod-schema' },
      { id: 'schema-2', name: 'prod private schema', slug: 'prod-private' },
    ]);
    container.registerInstance(LoggingEnvironmentService, { list: envList } as unknown as LoggingEnvironmentService);
    container.registerInstance(LoggingSchemaService, { list: schemaList } as unknown as LoggingSchemaService);
    const service = createService({ nodesService: {}, auditService });

    const result = await service.executeTool(
      { ...USER, scopes: ['logs:environments:view:env-1', 'logs:schemas:view:schema-1'] },
      'find_resource',
      { query: 'prod', types: ['logging_environment', 'logging_schema'] },
      {
        source: 'mcp',
        scopes: ['logs:environments:view:env-1', 'logs:schemas:view:schema-1'],
        tokenId: 'token-1',
        tokenPrefix: 'gwo_abc1234',
      }
    );

    expect(result.error).toBeUndefined();
    expect(envList).toHaveBeenCalledWith({ search: 'prod', allowedIds: ['env-1'] });
    expect(schemaList).toHaveBeenCalledWith({ search: 'prod' });
    expect((result.result as { results: Array<{ id: string }> }).results).toEqual([
      {
        type: 'logging_environment',
        id: 'env-1',
        name: 'prod logs',
        nodeId: undefined,
        summary: { id: 'env-1', name: 'prod logs', slug: 'prod' },
      },
      {
        type: 'logging_schema',
        id: 'schema-1',
        name: 'prod schema',
        nodeId: undefined,
        summary: { id: 'schema-1', name: 'prod schema', slug: 'prod-schema' },
      },
    ]);
  });

  it('filters direct manage_logging list operations to delegated resource-scoped grants', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const envList = vi.fn().mockResolvedValue([{ id: 'env-1', name: 'prod logs', slug: 'prod' }]);
    const schemaList = vi.fn().mockResolvedValue([
      { id: 'schema-1', name: 'prod schema', slug: 'prod-schema' },
      { id: 'schema-2', name: 'prod private schema', slug: 'prod-private' },
    ]);
    container.registerInstance(LoggingEnvironmentService, { list: envList } as unknown as LoggingEnvironmentService);
    container.registerInstance(LoggingSchemaService, { list: schemaList } as unknown as LoggingSchemaService);
    const service = createService({ nodesService: {}, auditService });

    const environments = await service.executeTool(
      { ...USER, scopes: ['logs:environments:view:env-1'] },
      'manage_logging',
      { resource: 'environment', operation: 'list', search: 'prod' },
      {
        source: 'mcp',
        scopes: ['logs:environments:view:env-1'],
        tokenId: 'token-1',
        tokenPrefix: 'gwo_abc1234',
      }
    );
    const schemas = await service.executeTool(
      { ...USER, scopes: ['logs:schemas:view:schema-1'] },
      'manage_logging',
      { resource: 'schema', operation: 'list', search: 'prod' },
      {
        source: 'mcp',
        scopes: ['logs:schemas:view:schema-1'],
        tokenId: 'token-1',
        tokenPrefix: 'gwo_abc1234',
      }
    );

    expect(environments.error).toBeUndefined();
    expect(envList).toHaveBeenCalledWith({ search: 'prod', allowedIds: ['env-1'] });
    expect(schemas.error).toBeUndefined();
    expect(schemas.result).toEqual([{ id: 'schema-1', name: 'prod schema', slug: 'prod-schema' }]);
  });

  it('authorizes proxy host creation from a node-scoped proxy:create grant', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const proxyService = {
      createProxyHost: vi.fn().mockResolvedValue({ id: 'proxy-1' }),
    };
    const service = createService({ nodesService: {}, proxyService, auditService });

    const result = await service.executeTool(
      { ...USER, scopes: ['proxy:create:node-1'] },
      'create_proxy_host',
      { nodeId: 'node-1', domainNames: ['example.com'] },
      { source: 'mcp', scopes: ['proxy:create:node-1'], tokenId: 'token-1', tokenPrefix: 'gwo_abc1234' }
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({ id: 'proxy-1' });
    expect(proxyService.createProxyHost).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'node-1', domainNames: ['example.com'] }),
      USER.id
    );
  });

  it('binds resource-scoped intermediate CA creation to the parent CA id', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const service = createService({ nodesService: {}, auditService });

    const result = await service.executeTool(
      { ...USER, scopes: ['pki:ca:create:intermediate:parent-a'] },
      'create_intermediate_ca',
      {
        parentCaId: 'parent-b',
        commonName: 'Intermediate CA',
        keyAlgorithm: 'rsa-2048',
        validityYears: 5,
      },
      {
        source: 'mcp',
        scopes: ['pki:ca:create:intermediate:parent-a'],
        tokenId: 'token-1',
        tokenPrefix: 'gwo_abc1234',
      }
    );

    expect(result.error).toContain('PERMISSION_DENIED');
  });

  it('filters CA list tools by root/intermediate view scopes', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const caService = {
      getCATree: vi.fn().mockResolvedValue([
        { id: 'root-1', type: 'root', commonName: 'Root' },
        { id: 'int-1', type: 'intermediate', commonName: 'Intermediate' },
      ]),
    };
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
      auditService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    (service as any).licensePolicyService = { requireFeature: vi.fn().mockResolvedValue(undefined) };

    const result = await service.executeTool({ ...USER, scopes: ['pki:ca:view:intermediate'] }, 'list_cas', {});

    expect(result.result).toEqual([{ id: 'int-1', type: 'intermediate', commonName: 'Intermediate' }]);
  });

  it('binds aggregate PKI template reads to the requested template id', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const templatesService = {
      getTemplate: vi.fn().mockResolvedValue({ id: 'template-2' }),
    };
    const service = createService({ nodesService: {}, templatesService, auditService });

    const denied = await service.executeTool(
      { ...USER, scopes: ['pki:templates:view:template-1'] },
      'manage_template',
      { operation: 'get', templateId: 'template-2' },
      {
        source: 'mcp',
        scopes: ['pki:templates:view:template-1'],
        tokenId: 'token-1',
        tokenPrefix: 'gwo_abc1234',
      }
    );

    expect(denied.error).toContain('PERMISSION_DENIED');
    expect(templatesService.getTemplate).not.toHaveBeenCalled();

    const allowed = await service.executeTool(
      { ...USER, scopes: ['pki:templates:view'] },
      'manage_template',
      { operation: 'get', templateId: 'template-2' },
      {
        source: 'mcp',
        scopes: ['pki:templates:view'],
        tokenId: 'token-1',
        tokenPrefix: 'gwo_abc1234',
      }
    );

    expect(allowed.error).toBeUndefined();
    expect(templatesService.getTemplate).toHaveBeenCalledWith('template-2');
  });

  it('enforces target CA type before deleting CAs through AI/MCP tools', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const caService = {
      getCA: vi.fn().mockResolvedValue({ id: 'int-1', type: 'intermediate', commonName: 'Intermediate' }),
      deleteCA: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService({ nodesService: {}, caService, auditService });

    const denied = await service.executeTool(
      { ...USER, scopes: ['pki:ca:revoke:root'] },
      'delete_ca',
      { caId: 'int-1' },
      {
        source: 'mcp',
        scopes: ['pki:ca:revoke:root'],
        tokenId: 'token-1',
        tokenPrefix: 'gwo_abc1234',
      }
    );

    expect(denied.error).toContain('PERMISSION_DENIED: Missing required scope pki:ca:revoke:intermediate');
    expect(caService.deleteCA).not.toHaveBeenCalled();

    const allowed = await service.executeTool(
      { ...USER, scopes: ['pki:ca:revoke:intermediate'] },
      'delete_ca',
      { caId: 'int-1' },
      {
        source: 'mcp',
        scopes: ['pki:ca:revoke:intermediate'],
        tokenId: 'token-1',
        tokenPrefix: 'gwo_abc1234',
      }
    );

    expect(allowed.error).toBeUndefined();
    expect(caService.deleteCA).toHaveBeenCalledWith('int-1', USER.id);
  });

  it('uses delegated MCP scopes for proxy advanced-config secondary checks', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const proxyService = {
      updateProxyHost: vi.fn().mockResolvedValue({ id: 'proxy-1' }),
    };
    const service = createService({ nodesService: {}, proxyService, auditService });

    const result = await service.executeTool(
      { ...USER, scopes: ['proxy:edit', 'proxy:advanced', 'proxy:advanced:bypass'] },
      'update_proxy_host',
      { proxyHostId: 'proxy-1', advancedConfig: 'proxy_set_header Host $host;' },
      { source: 'mcp', scopes: ['proxy:edit'], tokenId: 'token-1', tokenPrefix: 'gwo_abc1234' }
    );

    expect(result.error).toBe('Advanced config requires proxy:advanced scope');
    expect(proxyService.updateProxyHost).not.toHaveBeenCalled();
  });

  it('allows delegated MCP proxy edits with matching resource-scoped edit scope', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const proxyService = {
      updateProxyHost: vi.fn().mockResolvedValue({ id: 'proxy-1' }),
    };
    const service = createService({ nodesService: {}, proxyService, auditService });

    const result = await service.executeTool(
      { ...USER, scopes: ['proxy:edit', 'proxy:advanced', 'proxy:advanced:bypass'] },
      'update_proxy_host',
      { proxyHostId: 'proxy-1', enabled: false },
      { source: 'mcp', scopes: ['proxy:edit:proxy-1'], tokenId: 'token-1', tokenPrefix: 'gwo_abc1234' }
    );

    expect(result.error).toBeUndefined();
    expect(proxyService.updateProxyHost).toHaveBeenCalledWith(
      'proxy-1',
      { enabled: false },
      USER.id,
      expect.objectContaining({ bypassAdvancedValidation: false })
    );
  });

  it('executes blue/green deployment lifecycle tools through the deployment service', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const deploymentService = {
      start: vi.fn().mockResolvedValue({ id: 'dep-1', status: 'ready' }),
    };
    container.registerInstance(DockerDeploymentService, deploymentService as unknown as DockerDeploymentService);
    const service = createService({ nodesService: {}, auditService });

    const result = await service.executeTool(
      USER,
      'start_docker_deployment',
      { nodeId: 'node-1', deploymentId: 'dep-1' },
      { source: 'mcp', scopes: ['docker:containers:manage'], tokenId: 'token-1', tokenPrefix: 'gw_abc1234' }
    );

    expect(result.error).toBeUndefined();
    expect(deploymentService.start).toHaveBeenCalledWith('node-1', 'dep-1', USER.id);
    expect(result.result).toEqual({
      success: true,
      message: 'Deployment started',
      data: { id: 'dep-1', status: 'ready' },
    });
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER.id,
        action: 'mcp.start_docker_deployment',
        resourceType: 'docker',
        resourceId: 'dep-1',
        details: expect.objectContaining({
          source: 'mcp',
          success: true,
          toolName: 'start_docker_deployment',
          arguments: { nodeId: 'node-1', deploymentId: 'dep-1' },
        }),
      })
    );
  });
});
