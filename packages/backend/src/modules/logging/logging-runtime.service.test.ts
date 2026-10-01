import { describe, expect, it, vi } from 'vitest';
import { LoggingRuntimeService } from './logging-runtime.service.js';

function communityRuntime() {
  const settings = {
    saveConfig: vi.fn().mockResolvedValue({ mode: 'disabled' }),
    getPublicConfig: vi.fn().mockResolvedValue({ mode: 'disabled', passwordLast4: null }),
  };
  const runtime = new LoggingRuntimeService(settings as never, {} as never, {} as never, {} as never);
  return { runtime, settings };
}

describe('Community LoggingRuntimeService', () => {
  it('saves structured logging as disabled, so setup and settings work without the private module', async () => {
    const { runtime, settings } = communityRuntime();
    await expect(runtime.update({ mode: 'disabled' })).resolves.toEqual({ mode: 'disabled', passwordLast4: null });
    expect(settings.saveConfig).toHaveBeenCalledWith({ mode: 'disabled' });
  });

  it('refuses local and external storage before saving anything', async () => {
    const { runtime, settings } = communityRuntime();
    for (const mode of ['local', 'external'] as const) {
      await expect(runtime.update({ mode })).rejects.toMatchObject({
        statusCode: 503,
        code: 'COMMERCIAL_MODULE_UNAVAILABLE',
      });
    }
    expect(settings.saveConfig).not.toHaveBeenCalled();
  });
});
