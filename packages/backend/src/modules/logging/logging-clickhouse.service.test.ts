import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/config/env.js';

const clickhouse = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock('@clickhouse/client', () => ({ createClient: clickhouse.createClient }));

import { LoggingClickHouseService } from './logging-clickhouse.service.js';

function client() {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    command: vi.fn().mockResolvedValue({ query_id: 'query-1' }),
  };
}

describe('LoggingClickHouseService maintenance requests', () => {
  beforeEach(() => clickhouse.createClient.mockReset());

  it('uses a bounded maintenance client instead of the interactive request timeout', async () => {
    const primary = client();
    const maintenance = client();
    clickhouse.createClient.mockReturnValueOnce(primary).mockReturnValueOnce(maintenance);

    const service = new LoggingClickHouseService({
      CLICKHOUSE_URL: 'http://clickhouse:8123',
      CLICKHOUSE_USERNAME: 'default',
      CLICKHOUSE_PASSWORD: '',
      CLICKHOUSE_DATABASE: 'gateway_logs',
      CLICKHOUSE_LOGS_TABLE: 'logs',
      CLICKHOUSE_REQUEST_TIMEOUT_MS: 5_000,
    } as Env);

    expect(clickhouse.createClient).toHaveBeenNthCalledWith(1, expect.objectContaining({ request_timeout: 5_000 }));
    expect(clickhouse.createClient).toHaveBeenNthCalledWith(2, expect.objectContaining({ request_timeout: 60_000 }));

    await service.flushSystemLogs();
    await service.cleanInternalLogTable('metric_log');

    expect(primary.command).not.toHaveBeenCalled();
    expect(maintenance.command).toHaveBeenNthCalledWith(1, {
      query: 'SYSTEM FLUSH LOGS',
      clickhouse_settings: { log_queries: 0 },
    });
    expect(maintenance.command).toHaveBeenNthCalledWith(2, {
      query: 'TRUNCATE TABLE IF EXISTS `system`.`metric_log`',
      clickhouse_settings: { log_queries: 0 },
    });

    await service.close();
    expect(primary.close).toHaveBeenCalledTimes(1);
    expect(maintenance.close).toHaveBeenCalledTimes(1);
  });
});
