import 'reflect-metadata';
import { afterEach, type vi } from 'vitest';
import { container } from '@/container.js';
import { ALL_SCOPES } from '@/lib/scopes.js';
import { AIService } from '@/modules/ai/ai.service.js';
import { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import { DockerRegistryService } from '@/modules/docker/docker-registry.service.js';
import { LoggingEnvironmentService } from '@/modules/logging/logging-environment.service.js';
import { LoggingSchemaService } from '@/modules/logging/logging-schema.service.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { User } from '@/types.js';
import { registerMcpResources } from './mcp-resources.js';

export {
  AIService,
  container,
  DockerDeploymentService,
  DockerRegistryService,
  LoggingEnvironmentService,
  LoggingSchemaService,
  ProxyService,
  registerMcpResources,
};

export const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: ['nodes:details', 'nodes:create'],
  isBlocked: false,
};

export function createService({
  nodesService,
  proxyService = {},
  dockerService = {},
  databaseService = {},
  templatesService = {},
  caService = {},
  authService = { getUserById: async () => ({ ...USER, scopes: [...ALL_SCOPES] }) },
  auditService,
}: {
  nodesService: { list?: ReturnType<typeof vi.fn>; create?: ReturnType<typeof vi.fn> };
  proxyService?: Record<string, ReturnType<typeof vi.fn>>;
  dockerService?: Record<string, ReturnType<typeof vi.fn>>;
  databaseService?: Record<string, ReturnType<typeof vi.fn>>;
  templatesService?: Record<string, ReturnType<typeof vi.fn>>;
  caService?: Record<string, ReturnType<typeof vi.fn>>;
  authService?: { getUserById: (userId: string) => Promise<User | null> };
  auditService: { log: ReturnType<typeof vi.fn> };
}) {
  return new AIService(
    {} as never,
    caService as never,
    {} as never,
    templatesService as never,
    proxyService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    authService as never,
    auditService as never,
    {} as never,
    nodesService as never,
    {} as never,
    databaseService as never,
    dockerService as never
  );
}

afterEach(() => {
  container.reset();
});
