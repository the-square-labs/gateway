import { afterEach, describe, expect, it, vi } from 'vitest';
import { startInferenceWebSocketHeartbeat } from './inference-websocket-heartbeat.js';

afterEach(() => vi.useRealTimers());

function socket() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    ping: vi.fn((_data: unknown, _mask: boolean, callback: (error?: Error) => void) => callback()),
    close: vi.fn(),
    terminate: vi.fn(),
  };
}

describe('inference WebSocket keepalive', () => {
  it('sends control pings for 180 seconds without imposing a pong deadline', async () => {
    vi.useFakeTimers();
    const raw = socket();
    const failure = vi.fn();
    const stop = startInferenceWebSocketHeartbeat(raw, failure);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(raw.ping).toHaveBeenCalledTimes(9);
    expect(raw.ping).toHaveBeenCalledWith(undefined, false, expect.any(Function));
    expect(raw.close).not.toHaveBeenCalled();
    expect(raw.terminate).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    stop();
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not queue pings behind backpressure or an outstanding send', async () => {
    vi.useFakeTimers();
    const raw = socket();
    raw.bufferedAmount = 1;
    const stop = startInferenceWebSocketHeartbeat(raw, vi.fn());
    await vi.advanceTimersByTimeAsync(40_000);
    expect(raw.ping).not.toHaveBeenCalled();
    let done!: () => void;
    raw.ping.mockImplementationOnce((_data, _mask, callback) => {
      done = callback;
    });
    raw.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(raw.ping).toHaveBeenCalledOnce();
    done();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(raw.ping).toHaveBeenCalledTimes(2);
    stop();
  });

  it.each(['throw', 'callback'])('stops on a %s send error without closing the socket', async (mode) => {
    vi.useFakeTimers();
    const raw = socket();
    raw.ping.mockImplementation((_data, _mask, callback) => {
      if (mode === 'throw') throw new Error('private error text');
      callback(new Error('private error text'));
    });
    const failure = vi.fn();
    startInferenceWebSocketHeartbeat(raw, failure);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(raw.ping).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledExactlyOnceWith();
    expect(raw.close).not.toHaveBeenCalled();
    expect(raw.terminate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops when the socket starts closing and ignores late send callbacks after cleanup', async () => {
    vi.useFakeTimers();
    const raw = socket();
    const failure = vi.fn();
    let done!: (error?: Error) => void;
    raw.ping.mockImplementation((_data, _mask, callback) => {
      done = callback;
    });
    const stop = startInferenceWebSocketHeartbeat(raw, failure);
    await vi.advanceTimersByTimeAsync(20_000);
    raw.readyState = 2;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(vi.getTimerCount()).toBe(0);
    stop();
    done(new Error('late failure'));
    expect(failure).not.toHaveBeenCalled();
  });
});
