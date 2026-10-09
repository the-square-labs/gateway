import { createChildLogger } from '@/lib/logger.js';
import type { NotificationDeliveryService } from '@/modules/notifications/notification-delivery.service.js';
import type { NotificationDispatcherService } from '@/modules/notifications/notification-dispatcher.service.js';

const logger = createChildLogger('NotificationRetryJob');

const BATCH_SIZE = 20;

export class NotificationRetryJob {
  constructor(
    private deliveryService: NotificationDeliveryService,
    private dispatcherService: NotificationDispatcherService
  ) {}

  /** Each webhook with queued deliveries sends them in order; webhooks run side by side. */
  async run(): Promise<void> {
    const webhookIds = await this.deliveryService.getWebhooksDue(BATCH_SIZE);

    if (webhookIds.length === 0) return;

    logger.debug(`Sending the queued deliveries of ${webhookIds.length} webhook(s)`);

    const results = await Promise.allSettled(webhookIds.map((id) => this.dispatcherService.drainWebhook(id)));

    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      logger.warn(`${failed.length} webhook queue runs threw errors`);
    }
  }
}
