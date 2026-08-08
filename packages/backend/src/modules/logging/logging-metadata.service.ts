import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { loggingMetadata } from '@/db/schema/index.js';
import { logger } from '@/lib/logger.js';
import type { LoggingClickHouseRow } from './logging-storage.types.js';

type MetadataKind = 'service' | 'source' | 'label_key' | 'label_value' | 'field_key';
type MetadataEntry = { kind: MetadataKind; key: string; value: string; count: number };
type PendingMetadataEntry = MetadataEntry & { environmentId: string };

export const LOGGING_METADATA_KEY_MAX_LENGTH = 255;

export function isSupportedLoggingMetadataKey(key: string): boolean {
  return key.length <= LOGGING_METADATA_KEY_MAX_LENGTH;
}

export interface LoggingMetadataView {
  services: string[];
  sources: string[];
  labelKeys: string[];
  fieldKeys: string[];
  labelValues: Record<string, string[]>;
}

export class LoggingMetadataService {
  private readonly pending = new Map<string, PendingMetadataEntry>();
  private readonly maxPendingEntries = 5000;
  private readonly flushThreshold = 500;
  private readonly flushIntervalMs = 1000;
  private droppedEntries = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private currentFlush: Promise<void> | null = null;
  private flushing = false;
  private flushAgain = false;

  constructor(private readonly db: DrizzleClient) {}

  enqueue(environmentId: string, rows: LoggingClickHouseRow[]): void {
    const counts = new Map<string, MetadataEntry>();

    const add = (kind: MetadataKind, key: string, value: string | null = null) => {
      const normalizedKey = key.trim();
      const normalizedValue = value?.trim() || '';
      if (!normalizedKey || !isSupportedLoggingMetadataKey(normalizedKey)) return;
      const mapKey = `${kind}\0${normalizedKey}\0${normalizedValue ?? ''}`;
      const current = counts.get(mapKey);
      if (current) current.count += 1;
      else counts.set(mapKey, { kind, key: normalizedKey, value: normalizedValue, count: 1 });
    };

    for (const row of rows) {
      add('service', row.Service);
      add('source', row.Source);
      for (const [key, value] of Object.entries(row.Labels ?? {})) {
        add('label_key', key);
        add('label_value', key, value);
      }
      for (const key of [
        ...Object.keys(row.FieldStrings ?? {}),
        ...Object.keys(row.FieldNumbers ?? {}),
        ...Object.keys(row.FieldBooleans ?? {}),
        ...Object.keys(row.FieldDatetimes ?? {}),
        ...Object.keys(parseJsonObject(row.FieldsJson)),
      ]) {
        add('field_key', key);
      }
    }

    if (counts.size === 0) return;
    for (const entry of counts.values()) {
      const key = this.pendingKey(environmentId, entry);
      const current = this.pending.get(key);
      if (current) {
        current.count += entry.count;
        continue;
      }
      if (this.pending.size >= this.maxPendingEntries) {
        this.droppedEntries += entry.count;
        continue;
      }
      this.pending.set(key, { ...entry, environmentId });
    }

    if (this.pending.size >= this.flushThreshold) {
      this.flushSoon();
      return;
    }
    this.scheduleFlush();
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    while (this.currentFlush) {
      await this.currentFlush;
    }
  }

  private pendingKey(environmentId: string, entry: MetadataEntry) {
    return `${environmentId}\0${entry.kind}\0${entry.key}\0${entry.value}`;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.currentFlush = this.flush().finally(() => {
        this.currentFlush = null;
      });
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  private flushSoon(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.currentFlush = this.flush().finally(() => {
      this.currentFlush = null;
    });
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    if (this.pending.size === 0) return;

    this.flushing = true;
    const entries = [...this.pending.entries()];
    this.pending.clear();
    const now = new Date();
    const droppedEntries = this.droppedEntries;
    this.droppedEntries = 0;

    try {
      await this.db
        .insert(loggingMetadata)
        .values(
          entries.map(([, entry]) => ({
            environmentId: entry.environmentId,
            kind: entry.kind,
            key: entry.key,
            value: entry.value,
            count: entry.count,
            lastSeenAt: now,
          }))
        )
        .onConflictDoUpdate({
          target: [loggingMetadata.environmentId, loggingMetadata.kind, loggingMetadata.key, loggingMetadata.value],
          set: {
            count: sql`${loggingMetadata.count} + excluded.count`,
            lastSeenAt: now,
          },
        });
      if (droppedEntries > 0) {
        logger.warn('Dropped logging metadata entries because the metadata queue was full', {
          droppedEntries,
        });
      }
    } catch (err) {
      logger.warn('Failed to flush logging metadata', { err, droppedEntries, entries: entries.length });
    } finally {
      this.flushing = false;
      if (this.flushAgain) {
        this.flushAgain = false;
        this.flushSoon();
      } else if (this.pending.size > 0) {
        this.scheduleFlush();
      }
    }
  }

  async get(environmentId: string): Promise<LoggingMetadataView> {
    const rows = await this.db
      .select()
      .from(loggingMetadata)
      .where(
        and(
          eq(loggingMetadata.environmentId, environmentId),
          inArray(loggingMetadata.kind, ['service', 'source', 'label_key', 'field_key', 'label_value'])
        )
      )
      .orderBy(desc(loggingMetadata.count), desc(loggingMetadata.lastSeenAt))
      .limit(1000);

    const services: string[] = [];
    const sources: string[] = [];
    const labelKeys: string[] = [];
    const fieldKeys: string[] = [];
    const labelValues: Record<string, string[]> = {};

    for (const row of rows) {
      if (row.kind === 'service') services.push(row.key);
      else if (row.kind === 'source') sources.push(row.key);
      else if (row.kind === 'label_key') labelKeys.push(row.key);
      else if (row.kind === 'field_key') fieldKeys.push(row.key);
      else if (row.kind === 'label_value' && row.value) {
        labelValues[row.key] ??= [];
        if (labelValues[row.key]!.length < 100) labelValues[row.key]!.push(row.value);
      }
    }

    return {
      services: unique(services).slice(0, 100),
      sources: unique(sources).slice(0, 100),
      labelKeys: unique(labelKeys).slice(0, 100),
      fieldKeys: unique(fieldKeys).slice(0, 100),
      labelValues,
    };
  }
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function parseJsonObject(value: string): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
