import { describe, expect, it, vi } from 'vitest';
import { McpSettingsService } from './mcp-settings.service.js';

function createDb(row: { value: unknown } | null = null) {
  const values = vi.fn().mockReturnValue({
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  });
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(row ? [row] : []),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values,
    }),
    values,
  };
}

describe('McpSettingsService', () => {
  it('disables the MCP server by default', async () => {
    const service = new McpSettingsService(createDb() as any);

    await expect(service.getConfig()).resolves.toEqual({
      serverEnabled: false,
      extendedCompatibility: false,
    });
    await expect(service.isEnabled()).resolves.toBe(false);
  });

  it('reads stored server and extended compatibility settings', async () => {
    const service = new McpSettingsService(createDb({ value: true }) as any);

    await expect(service.getConfig()).resolves.toEqual({
      serverEnabled: true,
      extendedCompatibility: true,
    });
  });

  it('persists extended compatibility in the shared settings table', async () => {
    const db = createDb();
    const service = new McpSettingsService(db as any);

    await service.updateConfig({ extendedCompatibility: true });

    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'mcp:extended_compatibility',
        value: true,
      })
    );
  });
});
