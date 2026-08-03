import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';

const SETTINGS_KEY = 'web:transport';

export interface WebTransportSettings {
  tlsEnabled: boolean;
}

export class WebTransportSettingsService {
  private cached: WebTransportSettings | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly bootstrapMode?: 'http' | 'https'
  ) {}

  async initialize(): Promise<WebTransportSettings> {
    const existing = await this.readStored();
    if (existing) return existing;

    // Missing settings means an upgraded installation. Preserve its historic
    // HTTP behavior unless the fresh installer explicitly selected HTTPS.
    return this.updateConfig({ tlsEnabled: this.bootstrapMode === 'https' });
  }

  async getConfig(): Promise<WebTransportSettings> {
    if (this.cached) return this.cached;
    return (await this.readStored()) ?? this.initialize();
  }

  async updateConfig(next: WebTransportSettings): Promise<WebTransportSettings> {
    const normalized = { tlsEnabled: next.tlsEnabled === true };
    await this.db
      .insert(settings)
      .values({ key: SETTINGS_KEY, value: normalized, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: normalized, updatedAt: new Date() },
      });
    this.cached = normalized;
    return normalized;
  }

  private async readStored(): Promise<WebTransportSettings | null> {
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, SETTINGS_KEY))
      .limit(1);
    if (!row) return null;
    const value = typeof row.value === 'object' && row.value !== null ? (row.value as Record<string, unknown>) : {};
    const config = { tlsEnabled: value.tlsEnabled === true };
    this.cached = config;
    return config;
  }
}
