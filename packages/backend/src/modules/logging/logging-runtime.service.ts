import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { LocalClickHouseService } from './local-clickhouse.service.js';
import type { LoggingClickHouseService } from './logging-clickhouse.service.js';
import type { LoggingFeatureService } from './logging-feature.service.js';
import type { LoggingSettingsInput, LoggingSettingsService } from './logging-settings.service.js';
export class LoggingRuntimeService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(
    _settings: LoggingSettingsService,
    _local: LocalClickHouseService,
    _storage: LoggingClickHouseService,
    _feature: LoggingFeatureService
  ) {}
  setLicensePolicyService(_service: LicensePolicyService): void {}
  async initialize(): Promise<void> {}
  async update(_input: LoggingSettingsInput): Promise<{
    password: undefined;
    passwordLast4: string | null;
    mode: import('./logging-settings.service.js').LoggingStorageMode;
    url: string;
    username: string;
    database: string;
    table: string;
    requestTimeoutMs: number;
  }> {
    return commercialModuleUnavailable();
  }
  async snapshot(): Promise<import('./logging-settings.service.js').LoggingRuntimeSettings> {
    return {
      mode: 'disabled',
      url: '',
      username: '',
      password: '',
      database: 'gateway_logs',
      table: 'logs',
      requestTimeoutMs: 30000,
    };
  }
  async restore(_snapshot: Awaited<ReturnType<LoggingSettingsService['getRuntimeConfig']>>): Promise<void> {}
}
