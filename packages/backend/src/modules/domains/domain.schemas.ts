import { z } from 'zod';

const domainNameRegex = /^(\*\.)?([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

export const CreateDomainSchema = z.object({
  domain: z.string().trim().toLowerCase().min(1).max(253).regex(domainNameRegex, 'Invalid domain name format'),
  description: z.string().max(1000).optional(),
  folderId: z.string().uuid().optional().nullable(),
  ttl: z.coerce.number().int().min(1).max(86_400).optional(),
  proxied: z.boolean().optional(),
  overwriteDns: z.boolean().optional(),
  nginxNodeId: z.string().uuid().optional(),
});

export const PreviewDomainSchema = CreateDomainSchema.pick({
  domain: true,
  ttl: true,
  proxied: true,
  nginxNodeId: true,
});

export const UpdateDomainSchema = z.object({
  description: z.string().max(1000).optional().nullable(),
  proxied: z.boolean().optional(),
});

export const DeleteDomainSchema = z.object({
  deleteDns: z.boolean().optional(),
});

export const DomainListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(20),
  dnsStatus: z.enum(['valid', 'invalid', 'pending', 'unknown']).optional(),
  search: z.string().max(255).optional(),
});

export type CreateDomainInput = z.infer<typeof CreateDomainSchema>;
export type PreviewDomainInput = z.infer<typeof PreviewDomainSchema>;
export type UpdateDomainInput = z.infer<typeof UpdateDomainSchema>;
export type DeleteDomainInput = z.infer<typeof DeleteDomainSchema>;
export type DomainListQuery = z.infer<typeof DomainListQuerySchema>;
