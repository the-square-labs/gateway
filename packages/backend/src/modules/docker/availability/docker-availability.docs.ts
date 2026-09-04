import { z } from '@hono/zod-openapi';
import { appRoute, dataResponseSchema, jsonBody, jsonContent } from '@/lib/openapi.js';
import {
  DockerAvailabilityByResourceQuerySchema,
  DockerAvailabilityDisableInputSchema,
  DockerAvailabilityOperationIdSchema,
  DockerAvailabilityOperationSchema,
  DockerAvailabilityOperationsQuerySchema,
  DockerAvailabilityPolicyIdSchema,
  DockerAvailabilityPolicyInputSchema,
  DockerAvailabilityPolicySchema,
  DockerAvailabilityPolicyUpdateSchema,
  DockerAvailabilityPreflightSchema,
} from './docker-availability.schemas.js';

const policyParams = z.object({
  id: DockerAvailabilityPolicyIdSchema.openapi({
    param: { name: 'id', in: 'path' },
    example: '550e8400-e29b-41d4-a716-446655440000',
  }),
});

const operationParams = z.object({
  id: DockerAvailabilityPolicyIdSchema.openapi({
    param: { name: 'id', in: 'path' },
    example: '550e8400-e29b-41d4-a716-446655440000',
  }),
  operationId: DockerAvailabilityOperationIdSchema.openapi({
    param: { name: 'operationId', in: 'path' },
    example: '650e8400-e29b-41d4-a716-446655440000',
  }),
});

export const preflightDockerAvailabilityRoute = appRoute({
  method: 'post',
  path: '/availability/preflight',
  tags: ['Docker Availability'],
  summary: 'Preflight Docker Availability policy changes',
  request: jsonBody(DockerAvailabilityPolicyInputSchema),
  responses: {
    200: {
      description: 'Sanitized Docker Availability preflight report',
      content: jsonContent(dataResponseSchema(DockerAvailabilityPreflightSchema)),
    },
  },
});

export const enableDockerAvailabilityRoute = appRoute({
  method: 'post',
  path: '/availability',
  tags: ['Docker Availability'],
  summary: 'Enable Docker Availability for an existing resource',
  request: jsonBody(DockerAvailabilityPolicyInputSchema),
  responses: {
    202: {
      description: 'Docker Availability enablement accepted',
      content: jsonContent(dataResponseSchema(DockerAvailabilityPolicySchema)),
    },
  },
});

export const getDockerAvailabilityByResourceRoute = appRoute({
  method: 'get',
  path: '/availability/by-resource',
  tags: ['Docker Availability'],
  summary: 'Get Docker Availability by logical resource',
  request: { query: DockerAvailabilityByResourceQuerySchema },
  responses: {
    200: {
      description: 'Docker Availability policy for the resource, when enabled',
      content: jsonContent(dataResponseSchema(DockerAvailabilityPolicySchema.nullable())),
    },
  },
});

export const getDockerAvailabilityRoute = appRoute({
  method: 'get',
  path: '/availability/{id}',
  tags: ['Docker Availability'],
  summary: 'Get a Docker Availability policy',
  request: { params: policyParams },
  responses: {
    200: {
      description: 'Sanitized Docker Availability policy',
      content: jsonContent(dataResponseSchema(DockerAvailabilityPolicySchema)),
    },
  },
});

export const listDockerAvailabilityOperationsRoute = appRoute({
  method: 'get',
  path: '/availability/{id}/operations',
  tags: ['Docker Availability'],
  summary: 'List Docker Availability operations',
  request: { params: policyParams },
  responses: {
    200: {
      description: 'Docker Availability operation history',
      content: jsonContent(dataResponseSchema(z.array(DockerAvailabilityOperationSchema))),
    },
  },
});

export const listDockerAvailabilityOperationsPageRoute = appRoute({
  method: 'get',
  path: '/availability/{id}/operations/page',
  tags: ['Docker Availability'],
  summary: 'List a page of Docker Availability operations',
  request: { params: policyParams, query: DockerAvailabilityOperationsQuerySchema },
  responses: {
    200: {
      description: 'Paginated Docker Availability operation history',
      content: jsonContent(
        z.object({
          data: z.array(DockerAvailabilityOperationSchema),
          nextPage: z.number().int().nullable(),
        })
      ),
    },
  },
});

export const updateDockerAvailabilityRoute = appRoute({
  method: 'patch',
  path: '/availability/{id}',
  tags: ['Docker Availability'],
  summary: 'Update a Docker Availability policy',
  request: { params: policyParams, ...jsonBody(DockerAvailabilityPolicyUpdateSchema) },
  responses: {
    202: {
      description: 'Docker Availability update accepted',
      content: jsonContent(dataResponseSchema(DockerAvailabilityPolicySchema)),
    },
  },
});

export const disableDockerAvailabilityRoute = appRoute({
  method: 'post',
  path: '/availability/{id}/disable',
  tags: ['Docker Availability'],
  summary: 'Disable Docker Availability and keep one selected placement',
  request: { params: policyParams, ...jsonBody(DockerAvailabilityDisableInputSchema) },
  responses: {
    202: {
      description: 'Docker Availability disablement accepted',
      content: jsonContent(dataResponseSchema(DockerAvailabilityPolicySchema)),
    },
  },
});

export const retryDockerAvailabilityOperationRoute = appRoute({
  method: 'post',
  path: '/availability/{id}/operations/{operationId}/retry',
  tags: ['Docker Availability'],
  summary: 'Retry a recoverable Docker Availability operation',
  request: { params: operationParams },
  responses: {
    202: {
      description: 'Docker Availability operation retry accepted',
      content: jsonContent(dataResponseSchema(DockerAvailabilityOperationSchema)),
    },
  },
});
