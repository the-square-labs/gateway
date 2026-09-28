import { z } from 'zod';
import { INGRESS_GROUP_DNS_FAILOVER_MODES } from '@/db/schema/ingress-groups.js';

const NodeIdListSchema = z
  .array(z.string().uuid())
  .min(1, 'An ingress group needs at least one member')
  .max(16, 'An ingress group has at most 16 members')
  .refine((ids) => new Set(ids).size === ids.length, 'A node can be a member once');

export const CreateIngressGroupSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(1000).optional().nullable(),
  /** A node folder (ingress groups live in node folders). */
  folderId: z.string().uuid().optional().nullable(),
  /** Members in site-preference order (the first one is preferred). */
  nodeIds: NodeIdListSchema,
});

export const UpdateIngressGroupSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(1000).optional().nullable(),
  folderId: z.string().uuid().optional().nullable(),
  /**
   * How DNS of the group's Cloudflare-managed domains follows member health. `none`: every active member's address is
   * published (round robin, no health checks). DNS failover modes are added by later releases.
   */
  dnsFailoverMode: z.enum(INGRESS_GROUP_DNS_FAILOVER_MODES).optional(),
});

export const AddIngressGroupMemberSchema = z.object({
  nodeId: z.string().uuid(),
  /** 0-based position in the site-preference order; the end when omitted. */
  position: z.number().int().min(0).max(15).optional(),
});

export const RemoveIngressGroupMemberSchema = z.object({
  /**
   * Remove at once instead of draining: the member stops serving before DNS caches that still point at it expire.
   * Without it the member is withdrawn from DNS first and cleaned up once no public name resolves to it (at most 24 h).
   */
  force: z.boolean().optional().default(false),
});

export const ReorderIngressGroupSchema = z.object({
  /** Every member, in the new site-preference order. */
  nodeIds: NodeIdListSchema,
});

export const IngressGroupRouteConversionSchema = z.object({
  proxyHostId: z.string().uuid(),
});

export const IngressGroupDomainConversionSchema = z.object({
  domainId: z.string().uuid(),
});

export const IngressGroupListQuerySchema = z.object({
  search: z.string().max(255).optional(),
  folderId: z.string().uuid().optional(),
});

export type CreateIngressGroupInput = z.infer<typeof CreateIngressGroupSchema>;
export type UpdateIngressGroupInput = z.infer<typeof UpdateIngressGroupSchema>;
export type AddIngressGroupMemberInput = z.infer<typeof AddIngressGroupMemberSchema>;
export type RemoveIngressGroupMemberInput = z.input<typeof RemoveIngressGroupMemberSchema>;
export type IngressGroupListQuery = z.infer<typeof IngressGroupListQuerySchema>;
