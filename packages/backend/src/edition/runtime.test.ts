import { describe, expect, it, vi } from 'vitest';
import type { CommercialHost, CommercialRegistration } from './contract.js';
import type { LoadedCommercialPackage } from './loader.js';
import { CommercialEditionRuntime } from './runtime.js';

function loaded(registration: CommercialRegistration): LoadedCommercialPackage {
  return {
    manifest: { version: 'test' },
    releaseId: 'release',
    releaseDirectory: '/unused',
    module: { apiVersion: 1, register: vi.fn(() => registration) },
  } as unknown as LoadedCommercialPackage;
}

describe('commercial lifecycle', () => {
  it('keeps Community start/stop valid and paid operations unavailable', async () => {
    const runtime = CommercialEditionRuntime.community();
    expect(runtime.status).toEqual({ state: 'community' });
    expect(() => runtime.requireAvailable()).toThrow(/commercial module/);
    await runtime.start();
    await runtime.quiesce();
    await runtime.drain(Date.now() + 1000);
    await runtime.close(Date.now() + 1000);
  });

  it('uses the exact host object and invokes startup/recovery once', async () => {
    const lifecycle = {
      start: vi.fn(async () => {}),
      quiesce: vi.fn(async () => {}),
      drain: vi.fn(async () => {}),
      forceClose: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const host = { container: {}, db: {}, errors: {} } as CommercialHost;
    const pkg = loaded({ lifecycle });
    const runtime = await CommercialEditionRuntime.register(pkg, host);
    expect(pkg.module.register).toHaveBeenCalledWith(host);
    await Promise.all([runtime.start(), runtime.start()]);
    expect(lifecycle.start).toHaveBeenCalledTimes(1);
    await Promise.all([runtime.quiesce(), runtime.quiesce()]);
    expect(lifecycle.quiesce).toHaveBeenCalledTimes(1);
    await expect(runtime.start()).rejects.toThrow('shutdown');
    await Promise.all([runtime.drain(100), runtime.drain(100)]);
    await Promise.all([runtime.forceClose(), runtime.forceClose()]);
    await Promise.all([runtime.close(100), runtime.close(100)]);
    expect(lifecycle.drain).toHaveBeenCalledOnce();
    expect(lifecycle.forceClose).toHaveBeenCalledOnce();
    expect(lifecycle.close).toHaveBeenCalledOnce();
  });

  it('waits for a pending startup before quiescing its jobs', async () => {
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const quiesce = vi.fn(async () => {});
    const runtime = await CommercialEditionRuntime.register(
      loaded({
        lifecycle: {
          start: () => started,
          quiesce,
          drain: async () => {},
          forceClose: async () => {},
          close: async () => {},
        },
      }),
      {} as CommercialHost
    );
    const startup = runtime.start();
    const stopping = runtime.quiesce();
    await Promise.resolve();
    expect(quiesce).not.toHaveBeenCalled();
    release();
    await Promise.all([startup, stopping]);
    expect(quiesce).toHaveBeenCalledOnce();
  });

  it('does not turn a failed registration into a partially enabled module', async () => {
    const pkg = loaded({});
    pkg.module.register = async () => {
      throw new Error('registration failed');
    };
    await expect(CommercialEditionRuntime.register(pkg, {} as CommercialHost)).rejects.toThrow('registration failed');
  });
});
