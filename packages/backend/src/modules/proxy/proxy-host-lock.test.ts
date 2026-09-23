import { describe, expect, it } from 'vitest';
import { activeProxyLockCount, proxyHostLockKey, withProxyHostLock, withProxyLocks } from './proxy-host-lock.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('proxy host lock', () => {
  it('serializes build and apply of the same host in call order', async () => {
    const events: string[] = [];
    const gate = deferred();
    const first = withProxyHostLock('host-1', async () => {
      events.push('first:start');
      await gate.promise;
      events.push('first:end');
    });
    const second = withProxyHostLock('host-1', async () => {
      events.push('second:start');
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events).toEqual(['first:start']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    expect(activeProxyLockCount()).toBe(0);
  });

  it('does not block different hosts', async () => {
    const gate = deferred();
    const blocked = withProxyHostLock('host-a', () => gate.promise);
    await expect(withProxyHostLock('host-b', async () => 'done')).resolves.toBe('done');
    gate.resolve();
    await blocked;
  });

  it('is reentrant for keys already held by the same call chain', async () => {
    const result = await withProxyHostLock('host-1', () =>
      withProxyLocks([proxyHostLockKey('host-1')], () => withProxyHostLock('host-1', async () => 'nested'))
    );
    expect(result).toBe('nested');
    expect(activeProxyLockCount()).toBe(0);
  });

  it('releases the lock when the operation fails', async () => {
    await expect(
      withProxyHostLock('host-1', async () => {
        throw new Error('apply failed');
      })
    ).rejects.toThrow('apply failed');
    await expect(withProxyHostLock('host-1', async () => 'next')).resolves.toBe('next');
    expect(activeProxyLockCount()).toBe(0);
  });
});
