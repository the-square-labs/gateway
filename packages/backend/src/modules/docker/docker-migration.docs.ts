import { z } from '@hono/zod-openapi';
import { appRoute, dataResponseSchema, jsonBody, jsonContent, pathParamSchema } from '@/lib/openapi.js';
import {
  DockerMigrationCreateInputSchema,
  DockerMigrationListQuerySchema,
  DockerMigrationPreflightInputSchema,
  DockerMigrationPreflightSchema,
  DockerMigrationResolveInputSchema,
  DockerMigrationSchema,
} from './docker-migration.schemas.js';

const migrationParams = pathParamSchema('id');

export const preflightDockerMigrationRoute = appRoute({
  method: 'post',
  path: '/migrations/preflight',
  tags: ['Docker Migrations'],
  summary: 'Preflight a Docker node migration',
  request: jsonBody(DockerMigrationPreflightInputSchema),
  responses: {
    200: {
      description: 'Sanitized migration preflight report',
      content: jsonContent(dataResponseSchema(DockerMigrationPreflightSchema)),
    },
  },
});

export const createDockerMigrationRoute = appRoute({
  method: 'post',
  path: '/migrations',
  tags: ['Docker Migrations'],
  summary: 'Start a durable Docker node migration',
  request: jsonBody(DockerMigrationCreateInputSchema),
  responses: {
    202: { description: 'Migration accepted', content: jsonContent(dataResponseSchema(DockerMigrationSchema)) },
  },
});

export const listDockerMigrationsRoute = appRoute({
  method: 'get',
  path: '/migrations',
  tags: ['Docker Migrations'],
  summary: 'List visible Docker migrations',
  request: { query: DockerMigrationListQuerySchema },
  responses: {
    200: {
      description: 'Visible migration history',
      content: jsonContent(dataResponseSchema(z.array(DockerMigrationSchema))),
    },
  },
});

export const getDockerMigrationRoute = appRoute({
  method: 'get',
  path: '/migrations/{id}',
  tags: ['Docker Migrations'],
  summary: 'Get a Docker migration',
  request: { params: migrationParams },
  responses: {
    200: {
      description: 'Sanitized migration details',
      content: jsonContent(dataResponseSchema(DockerMigrationSchema.passthrough())),
    },
  },
});

export const cancelDockerMigrationRoute = appRoute({
  method: 'post',
  path: '/migrations/{id}/cancel',
  tags: ['Docker Migrations'],
  summary: 'Cancel and roll back a migration before cutover',
  request: { params: migrationParams },
  responses: {
    200: { description: 'Cancellation requested', content: jsonContent(dataResponseSchema(DockerMigrationSchema)) },
  },
});

export const retryDockerMigrationCleanupRoute = appRoute({
  method: 'post',
  path: '/migrations/{id}/retry-cleanup',
  tags: ['Docker Migrations'],
  summary: 'Retry source cleanup after a successful cutover',
  request: { params: migrationParams },
  responses: {
    200: { description: 'Cleanup retry accepted', content: jsonContent(dataResponseSchema(DockerMigrationSchema)) },
  },
});

export const resolveDockerMigrationRoute = appRoute({
  method: 'post',
  path: '/migrations/{id}/resolve',
  tags: ['Docker Migrations'],
  summary: 'Resolve a migration that needs attention',
  description:
    'Confirms which node is authoritative after an operator reconciled both nodes, then releases the migration lock and the maintenance mode the migration entered. Resolving to the source restores the restart policy the migration replaced on the source. No container is started or removed.',
  request: { params: migrationParams, ...jsonBody(DockerMigrationResolveInputSchema) },
  responses: {
    200: { description: 'Migration resolved', content: jsonContent(dataResponseSchema(DockerMigrationSchema)) },
  },
});
