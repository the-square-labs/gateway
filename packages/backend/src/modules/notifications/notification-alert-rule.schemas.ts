import { z } from 'zod';

const alertCategorySchema = z.enum([
  'node',
  'container',
  'proxy',
  'gateway',
  'logging',
  'integration',
  'certificate',
  'security',
  'database_postgres',
  'database_clickhouse',
  'database_redis',
]);

export const AlertRuleListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  type: z.enum(['threshold', 'event']).optional(),
  category: alertCategorySchema.optional(),
  enabled: z.coerce.boolean().optional(),
  search: z.string().optional(),
});

export type AlertRuleListQuery = z.infer<typeof AlertRuleListQuerySchema>;

export const CreateAlertRuleSchema = z
  .object({
    name: z.string().min(1).max(255),
    enabled: z.boolean().default(false),
    type: z.enum(['threshold', 'event']),
    category: alertCategorySchema,
    severity: z.enum(['info', 'warning', 'critical']).default('warning'),

    // Threshold
    metric: z.string().max(100).optional(),
    metricTarget: z.string().max(255).nullable().optional(),
    operator: z.enum(['>', '>=', '<', '<=']).optional(),
    thresholdValue: z.number().optional(),
    durationSeconds: z.number().int().min(0).default(0),
    fireThresholdPercent: z.number().int().min(0).max(100).default(100),
    resolveAfterSeconds: z.number().int().min(0).default(60),
    resolveThresholdPercent: z.number().int().min(0).max(100).default(100),

    // Event
    eventPattern: z.string().max(255).optional(),

    // Scope
    resourceIds: z.array(z.string()).default([]),

    // Message template
    messageTemplate: z.string().max(4096).optional(),

    // Webhooks to deliver to
    webhookIds: z.array(z.string().uuid()).default([]),

    // Cooldown
    cooldownSeconds: z.number().int().min(0).default(900),
  })
  .refine(
    (data) => {
      if (data.type === 'threshold') {
        return !!data.metric && !!data.operator && data.thresholdValue !== undefined;
      }
      return true;
    },
    { message: 'Threshold rules require metric, operator, and thresholdValue' }
  )
  .refine(
    (data) => {
      if (data.type === 'event') {
        return !!data.eventPattern;
      }
      return true;
    },
    { message: 'Event rules require eventPattern' }
  );

export type CreateAlertRuleInput = z.infer<typeof CreateAlertRuleSchema>;

export const UpdateAlertRuleSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  enabled: z.boolean().optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  metric: z.string().max(100).optional(),
  metricTarget: z.string().max(255).nullable().optional(),
  operator: z.enum(['>', '>=', '<', '<=']).optional(),
  thresholdValue: z.number().optional(),
  durationSeconds: z.number().int().min(0).optional(),
  fireThresholdPercent: z.number().int().min(0).max(100).optional(),
  resolveAfterSeconds: z.number().int().min(0).optional(),
  resolveThresholdPercent: z.number().int().min(0).max(100).optional(),
  eventPattern: z.string().max(255).optional(),
  resourceIds: z.array(z.string()).optional(),
  messageTemplate: z.string().max(4096).optional(),
  webhookIds: z.array(z.string().uuid()).optional(),
  cooldownSeconds: z.number().int().min(0).optional(),
});

export type UpdateAlertRuleInput = z.infer<typeof UpdateAlertRuleSchema>;
