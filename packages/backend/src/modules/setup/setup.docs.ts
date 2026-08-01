import { z } from '@hono/zod-openapi';
import { appRoute, dataResponseSchema, jsonBody, okJson, UnknownDataResponseSchema } from '@/lib/openapi.js';

const ManagementSslSchema = z.object({
  domain: z.string().min(1),
});

const EnrollNodeSchema = z.object({
  type: z.enum(['nginx', 'bastion', 'monitoring', 'docker', 'databases']).optional(),
  hostname: z.string().optional(),
});

const EnrollNodeResponseSchema = dataResponseSchema(
  z.object({
    node: z
      .object({
        id: z.string().uuid(),
        type: z.enum(['nginx', 'bastion', 'monitoring', 'docker', 'databases']),
        hostname: z.string(),
        status: z.enum(['pending', 'online', 'offline', 'error']),
      })
      .catchall(z.any()),
    enrollmentToken: z.string().openapi({
      description: 'One-time enrollment token returned only once during setup.',
      example: 'gw_node_v2_0123456789abcdef_0123456789abcdef0123456789abcdef0123456789abcdef',
    }),
    gatewayCertSha256: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .openapi({
        description: 'SHA-256 fingerprint of the active Gateway gRPC TLS leaf certificate.',
        example: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      }),
  })
);

const ManagementSslUploadSchema = z.object({
  domain: z.string().min(1),
  certificatePem: z.string().min(1),
  privateKeyPem: z.string().min(1),
  chainPem: z.string().optional(),
});

export const setupManagementSslRoute = appRoute({
  method: 'post',
  path: '/management-ssl',
  tags: ['Setup'],
  summary: 'Bootstrap management SSL with ACME before Gateway is configured',
  description:
    'Bootstrap-only endpoint. After setup is completed or has been open for one hour, this endpoint returns 404; use authenticated SSL UI/API flows instead.',
  security: [{ bearerAuth: [] }],
  request: jsonBody(ManagementSslSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const setupEnrollNodeRoute = appRoute({
  method: 'post',
  path: '/enroll-node',
  tags: ['Setup'],
  summary: 'Enroll a node during first-run bootstrap',
  description:
    'Bootstrap-only endpoint. After setup is completed or has been open for one hour, this endpoint returns 404; use authenticated node enrollment UI/API flows instead.',
  security: [{ bearerAuth: [] }],
  request: jsonBody(EnrollNodeSchema),
  responses: okJson(EnrollNodeResponseSchema),
});

export const setupManagementSslUploadRoute = appRoute({
  method: 'post',
  path: '/management-ssl-upload',
  tags: ['Setup'],
  summary: 'Bootstrap management SSL with an uploaded certificate before Gateway is configured',
  description:
    'Bootstrap-only endpoint. After setup is completed or has been open for one hour, this endpoint returns 404; use authenticated SSL UI/API flows instead.',
  security: [{ bearerAuth: [] }],
  request: jsonBody(ManagementSslUploadSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const setupCompleteRoute = appRoute({
  method: 'post',
  path: '/complete',
  tags: ['Setup'],
  summary: 'Mark first-run setup complete',
  description:
    'Bootstrap-only endpoint. The installer calls this after the setup flow finishes so setup-token endpoints close without racing the first user login. New installer-created setup windows also expire automatically one hour after first start.',
  security: [{ bearerAuth: [] }],
  responses: okJson(UnknownDataResponseSchema),
});
