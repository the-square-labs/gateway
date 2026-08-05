import { createChildLogger } from '@/lib/logger.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { UpdateService } from '@/services/update.service.js';

const logger = createChildLogger('UpdateCheckJob');

export class UpdateCheckJob {
  constructor(
    private readonly updateService: UpdateService,
    private readonly eventBus?: EventBusService
  ) {}

  async run(): Promise<void> {
    logger.debug('Running scheduled update check');
    try {
      const status = await this.updateService.checkForUpdates();
      this.eventBus?.publish('system.update.changed', { updating: false, statusChanged: true });
      if (status.updateAvailable) {
        logger.info(`Update available: ${status.currentVersion} → ${status.latestVersion}`);
      }
    } catch (error) {
      logger.error('Update check failed', { error });
    }
  }
}
