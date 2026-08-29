import { z } from '@hono/zod-openapi';
import {
  appRoute,
  jsonBody,
  NodeIdParamSchema,
  okJson,
  pathParamSchema,
  UnknownDataResponseSchema,
} from '@/lib/openapi.js';
import { RELEASE_VERSION_PATTERN } from '@/lib/semver.js';

const VersionParamSchema = pathParamSchema('version');
const UpdateRequestSchema = z.object({
  version: z.string().regex(RELEASE_VERSION_PATTERN),
});

export const systemVersionRoute = appRoute({
  method: 'get',
  path: '/version',
  tags: ['System'],
  summary: 'Get gateway version and update status',
  responses: okJson(UnknownDataResponseSchema),
});

export const systemConfigRoute = appRoute({
  method: 'get',
  path: '/config',
  tags: ['System'],
  summary: 'Get gateway runtime configuration',
  responses: okJson(UnknownDataResponseSchema),
});

export const checkSystemUpdateRoute = appRoute({
  method: 'post',
  path: '/check-update',
  tags: ['System'],
  summary: 'Check for gateway updates',
  responses: okJson(UnknownDataResponseSchema),
});

export const performSystemUpdateRoute = appRoute({
  method: 'post',
  path: '/update',
  tags: ['System'],
  summary: 'Trigger gateway self-update',
  request: jsonBody(UpdateRequestSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const performRelayUpdateRoute = appRoute({
  method: 'post',
  path: '/relay-update',
  tags: ['System'],
  summary: 'Trigger relay self-update',
  request: jsonBody(UpdateRequestSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const releaseNotesForVersionRoute = appRoute({
  method: 'get',
  path: '/release-notes/{version}',
  tags: ['System'],
  summary: 'Get release notes for a version',
  request: { params: VersionParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const releaseNotesRoute = appRoute({
  method: 'get',
  path: '/release-notes',
  tags: ['System'],
  summary: 'Get release notes for available updates',
  responses: okJson(UnknownDataResponseSchema),
});

export const daemonUpdatesRoute = appRoute({
  method: 'get',
  path: '/daemon-updates',
  tags: ['System'],
  summary: 'List daemon update status',
  responses: okJson(UnknownDataResponseSchema),
});

export const checkDaemonUpdatesRoute = appRoute({
  method: 'post',
  path: '/daemon-updates/check',
  tags: ['System'],
  summary: 'Check for daemon updates',
  responses: okJson(UnknownDataResponseSchema),
});

export const updateDaemonRoute = appRoute({
  method: 'post',
  path: '/daemon-updates/{nodeId}',
  tags: ['System'],
  summary: 'Trigger daemon update for a node',
  request: { params: NodeIdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});
