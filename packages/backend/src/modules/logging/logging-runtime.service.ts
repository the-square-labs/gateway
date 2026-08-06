import type { LocalClickHouseService } from './local-clickhouse.service.js';
import type { LoggingClickHouseService } from './logging-clickhouse.service.js';
import type { LoggingFeatureService } from './logging-feature.service.js';
import type { LoggingSettingsInput, LoggingSettingsService } from './logging-settings.service.js';

export class LoggingRuntimeService {
  constructor(
    private readonly settings: LoggingSettingsService,
    private readonly local: LocalClickHouseService,
    private readonly storage: LoggingClickHouseService,
    private readonly feature: LoggingFeatureService
  ) {}

  async initialize(): Promise<void> {
    await this.applyRuntime(await this.settings.getRuntimeConfig());
  }

  async update(input: LoggingSettingsInput) {
    const runtime = await this.settings.saveConfig(input);
    await this.applyRuntime(runtime);
    return this.settings.getPublicConfig();
  }

  async snapshot() {
    return this.settings.getRuntimeConfig();
  }

  async restore(snapshot: Awaited<ReturnType<LoggingSettingsService['getRuntimeConfig']>>): Promise<void> {
    const runtime = await this.settings.saveConfig(snapshot);
    await this.applyRuntime(runtime);
  }

  private async applyRuntime(runtime: Awaited<ReturnType<LoggingSettingsService['getRuntimeConfig']>>): Promise<void> {
    if (runtime.mode === 'local') {
      await this.local.reconcile(runtime);
      await this.storage.configure(runtime);
    } else {
      await this.storage.configure(runtime);
      await this.local.reconcile(runtime);
    }
    if (runtime.mode === 'disabled') {
      this.feature.markUnavailable('Structured logging is disabled');
      return;
    }

    const reachable =
      runtime.mode === 'local' ? await this.waitForLocalClickHouse() : await this.storage.ping().catch(() => false);
    if (!reachable) {
      this.feature.markUnavailable('ClickHouse ping failed');
      throw new Error('ClickHouse ping failed');
    }
    await this.storage.ensureSchema();
    this.feature.markAvailable();
  }

  private async waitForLocalClickHouse(): Promise<boolean> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await this.storage.ping().catch(() => false)) return true;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }
}
