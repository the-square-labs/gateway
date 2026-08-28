import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';
import type { CryptoService } from '@/services/crypto.service.js';
import { validateClickHouseIdentifier } from './logging-query-builder.js';

const SETTINGS_KEY = 'logging:clickhouse';

export type LoggingStorageMode = 'disabled' | 'local' | 'external';

interface EncryptedSecret {
  encryptedKey: string;
  encryptedDek: string;
}

interface StoredLoggingSettings {
  mode: LoggingStorageMode;
  url: string;
  username: string;
  password: EncryptedSecret | null;
  database: string;
  table: string;
  requestTimeoutMs: number;
}

export interface LoggingRuntimeSettings {
  mode: LoggingStorageMode;
  url: string;
  username: string;
  password: string;
  database: string;
  table: string;
  requestTimeoutMs: number;
}

export interface LegacyLoggingEnvironment {
  CLICKHOUSE_URL: string;
  CLICKHOUSE_USERNAME: string;
  CLICKHOUSE_PASSWORD: string;
  CLICKHOUSE_DATABASE: string;
  CLICKHOUSE_LOGS_TABLE: string;
  CLICKHOUSE_REQUEST_TIMEOUT_MS: number;
}

export interface LoggingSettingsInput {
  mode: LoggingStorageMode;
  url?: string;
  username?: string;
  password?: string;
  database?: string;
  table?: string;
  requestTimeoutMs?: number;
}

export class LoggingSettingsService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService
  ) {}

  async getRuntimeConfig(): Promise<LoggingRuntimeSettings> {
    const stored = await this.getStored();
    if (!stored) return disabledConfig();
    return {
      ...stored,
      password: stored.password ? this.cryptoService.decryptString(stored.password) : '',
    };
  }

  async getPublicConfig() {
    const runtime = await this.getRuntimeConfig();
    return {
      ...runtime,
      password: undefined,
      passwordLast4: runtime.password ? runtime.password.slice(-4) : null,
    };
  }

  async saveConfig(input: LoggingSettingsInput): Promise<LoggingRuntimeSettings> {
    const previous = await this.getStored();
    if (input.mode === 'disabled') {
      await this.setStored(previous ? { ...previous, mode: 'disabled' } : { ...disabledConfig(), password: null });
      return this.getRuntimeConfig();
    }

    const local = input.mode === 'local';
    const previousWasLocal = (() => {
      try {
        const hostname = new URL(previous?.url ?? '').hostname;
        return hostname === 'clickhouse' || hostname === 'gateway-clickhouse';
      } catch {
        return false;
      }
    })();
    const requestedUrl = input.url?.trim();
    const rawUrl = local
      ? requestedUrl || (previousWasLocal ? previous?.url : undefined) || 'http://gateway-clickhouse:8123'
      : (requestedUrl ?? '');
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error('ClickHouse URL must be a valid absolute URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('ClickHouse URL must use http or https');

    const username = (input.username ?? (local ? 'gateway' : previous?.username) ?? '').trim();
    if (!username) throw new Error('ClickHouse username is required');
    const rawPassword =
      input.password ?? (local && !previousWasLocal ? randomBytes(32).toString('base64url') : undefined);
    const password =
      rawPassword !== undefined
        ? this.cryptoService.encryptString(rawPassword)
        : previousWasLocal || !local
          ? previous?.password
          : undefined;
    if (!password) throw new Error('ClickHouse password is required');
    const database = validateClickHouseIdentifier(input.database ?? previous?.database ?? 'gateway_logs');
    const table = validateClickHouseIdentifier(input.table ?? previous?.table ?? 'logs');
    const requestTimeoutMs = input.requestTimeoutMs ?? previous?.requestTimeoutMs ?? 5000;
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1)
      throw new Error('ClickHouse request timeout must be positive');

    await this.setStored({
      mode: input.mode,
      url: url.toString(),
      username,
      password,
      database,
      table,
      requestTimeoutMs,
    });
    return this.getRuntimeConfig();
  }

  async importLegacyEnv(env: LegacyLoggingEnvironment): Promise<boolean> {
    if (await this.getStored()) return false;
    if (!env.CLICKHOUSE_URL) {
      await this.saveConfig({ mode: 'disabled' });
      return false;
    }
    const hostname = new URL(env.CLICKHOUSE_URL).hostname;
    await this.saveConfig({
      mode: hostname === 'clickhouse' || hostname === 'gateway-clickhouse' ? 'local' : 'external',
      url: env.CLICKHOUSE_URL,
      username: env.CLICKHOUSE_USERNAME,
      password: env.CLICKHOUSE_PASSWORD,
      database: env.CLICKHOUSE_DATABASE,
      table: env.CLICKHOUSE_LOGS_TABLE,
      requestTimeoutMs: env.CLICKHOUSE_REQUEST_TIMEOUT_MS,
    });
    return true;
  }

  private async getStored(): Promise<StoredLoggingSettings | null> {
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, SETTINGS_KEY))
      .limit(1);
    return (row?.value as StoredLoggingSettings | undefined) ?? null;
  }

  private async setStored(value: StoredLoggingSettings): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key: SETTINGS_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }
}

function disabledConfig(): LoggingRuntimeSettings {
  return {
    mode: 'disabled',
    url: '',
    username: '',
    password: '',
    database: 'gateway_logs',
    table: 'logs',
    requestTimeoutMs: 5000,
  };
}
