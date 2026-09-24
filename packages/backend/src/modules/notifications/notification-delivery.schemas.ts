import { z } from 'zod';

export const DeliveryListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  webhookId: z.string().uuid().optional(),
  status: z.enum(['pending', 'success', 'failed', 'retrying']).optional(),
  eventType: z.string().optional(),
});
