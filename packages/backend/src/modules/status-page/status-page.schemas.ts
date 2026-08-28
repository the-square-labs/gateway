import { z } from 'zod';

const domainNameRegex = /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const upstreamUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  }, 'Upstream URL must use http or https')
  .refine((value) => {
    const url = new URL(value);
    return url.pathname === '/' && !url.search && !url.hash;
  }, 'Upstream URL must not include path, query, or hash');

export const StatusPageSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  title: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  domain: z.string().trim().toLowerCase().regex(domainNameRegex, 'Invalid domain name').optional().or(z.literal('')),
  nodeId: z.string().uuid().optional().nullable(),
  sslCertificateId: z.string().uuid().optional().nullable(),
  proxyTemplateId: z.string().uuid().optional().nullable(),
  upstreamUrl: upstreamUrlSchema.optional().nullable().or(z.literal('')),
  publicIncidentLimit: z.number().int().min(1).max(100).optional(),
  recentIncidentDays: z.number().int().min(1).max(365).optional(),
  autoDegradedEnabled: z.boolean().optional(),
  autoOutageEnabled: z.boolean().optional(),
  autoDegradedSeverity: z.enum(['info', 'warning', 'critical']).optional(),
  autoOutageSeverity: z.enum(['info', 'warning', 'critical']).optional(),
  autoCreateThresholdSeconds: z.number().int().min(30).max(86400).optional(),
  autoResolveThresholdSeconds: z.number().int().min(30).max(86400).optional(),
});

export const CreateStatusPageServiceSchema = z.object({
  sourceType: z.enum([
    'node',
    'proxy_host',
    'database',
    'docker_container',
    'docker_deployment',
    'docker_compose_project',
    'pages_project',
  ]),
  sourceId: z.string().uuid(),
  publicName: z.string().min(1).max(255),
  publicDescription: z.string().max(1000).optional().nullable(),
  publicGroup: z.string().max(255).optional().nullable(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  enabled: z.boolean().optional(),
  createThresholdSeconds: z.number().int().min(30).max(86400).optional(),
  resolveThresholdSeconds: z.number().int().min(30).max(86400).optional(),
});

export const UpdateStatusPageServiceSchema = CreateStatusPageServiceSchema.partial().omit({
  sourceType: true,
  sourceId: true,
});

export const ReorderStatusPageServicesSchema = z.object({
  serviceIds: z
    .array(z.string().uuid())
    .min(1)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, 'Service ids must be unique'),
});

export const CreateStatusPageIncidentSchema = z.object({
  title: z.string().min(1).max(255),
  message: z.string().min(1).max(5000),
  severity: z.enum(['info', 'warning', 'critical']).default('warning'),
  affectedServiceIds: z.array(z.string().uuid()).default([]),
  startedAt: z.string().datetime().optional(),
});

export const UpdateStatusPageIncidentSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  message: z.string().min(1).max(5000).optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  affectedServiceIds: z.array(z.string().uuid()).optional(),
  status: z.enum(['active', 'resolved']).optional(),
  autoManaged: z.boolean().optional(),
});

export const CreateStatusPageIncidentUpdateSchema = z.object({
  message: z.string().min(1).max(5000),
  status: z.enum(['update', 'investigating', 'identified', 'monitoring', 'resolved']).default('update'),
});

export const IncidentListQuerySchema = z.object({
  status: z.enum(['active', 'resolved', 'all']).optional().default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export type StatusPageSettingsInput = z.infer<typeof StatusPageSettingsSchema>;
export type CreateStatusPageServiceInput = z.infer<typeof CreateStatusPageServiceSchema>;
export type UpdateStatusPageServiceInput = z.infer<typeof UpdateStatusPageServiceSchema>;
export type ReorderStatusPageServicesInput = z.infer<typeof ReorderStatusPageServicesSchema>;
export type CreateStatusPageIncidentInput = z.infer<typeof CreateStatusPageIncidentSchema>;
export type UpdateStatusPageIncidentInput = z.infer<typeof UpdateStatusPageIncidentSchema>;
export type CreateStatusPageIncidentUpdateInput = z.infer<typeof CreateStatusPageIncidentUpdateSchema>;
