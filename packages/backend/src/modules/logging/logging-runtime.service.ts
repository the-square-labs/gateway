import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { LocalClickHouseService } from './local-clickhouse.service.js';
import type { LoggingClickHouseService } from './logging-clickhouse.service.js';
import type { LoggingFeatureService } from './logging-feature.service.js';
import type { LoggingSettingsInput, LoggingSettingsService } from './logging-settings.service.js';

export class LoggingRuntimeService {
  private licensePolicy?: LicensePolicyService;
  constructor(
    private readonly settings: LoggingSettingsService,
    private readonly local: LocalClickHouseService,
    private readonly storage: LoggingClickHouseService,
    private readonly feature: LoggingFeatureService
  ) {}

  setLicensePolicyService(service: LicensePolicyService): void {
    this.licensePolicy = service;
  }

  async initialize(): Promise<void> {
    let runtime = await this.settings.getRuntimeConfig();
    if (
      runtime.mode !== 'disabled' &&
      this.licensePolicy &&
      !(await this.licensePolicy.hasFeature('structured-logging'))
    ) {
      // LICENSE ENFORCEMENT: Do not start a persisted paid logging backend after entitlement loss.
      runtime = await this.settings.saveConfig({ mode: 'disabled' });
    }
    await this.applyRuntime(runtime);
  }

  async update(input: LoggingSettingsInput) {
    if (input.mode !== 'disabled') {
      // LICENSE ENFORCEMENT: Enabling structured logging requires Business under the project license/TOS.
      await this.licensePolicy?.requireFeature('structured-logging');
    }
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
