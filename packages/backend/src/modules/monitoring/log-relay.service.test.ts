import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  daemonLogRelay,
  getDaemonLogHistory,
  getNginxLogHistory,
  LOG_HISTORY_IDLE_TTL_MS,
  LOG_HISTORY_MAX_KEYS,
  logRelay,
  resetNginxLogHistoryForTest,
} from './log-relay.service.js';

beforeEach(() => {
  vi.useFakeTimers();
  resetNginxLogHistoryForTest();
});
afterEach(() => {
  resetNginxLogHistoryForTest();
  vi.useRealTimers();
});
const nginx = (hostId: string, raw = 'line') => logRelay.emit('log', { hostId, nodeId: 'node', raw });
const daemon = (nodeId: string) => daemonLogRelay.emit('log', { nodeId, message: 'line' });

describe('log history retention', () => {
  it('bounds total keys across both kinds and evicts the least recently written resource', () => {
    nginx('old');
    daemon('keep');
    for (let i = 0; i < LOG_HISTORY_MAX_KEYS - 2; i++) nginx(String(i));
    daemon('keep');
    nginx('new');
    expect(getNginxLogHistory('old')).toEqual([]);
    expect(getDaemonLogHistory('keep')).toHaveLength(2);
    expect(getNginxLogHistory('new')).toHaveLength(1);
  });
  it('expires idle keys without new writes and stops the idle sweep when empty', async () => {
    nginx('gone');
    daemon('gone');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(LOG_HISTORY_IDLE_TTL_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(getNginxLogHistory('gone')).toEqual([]);
    expect(getDaemonLogHistory('gone')).toEqual([]);
    daemon('new');
    expect(vi.getTimerCount()).toBe(1);
  });
  it('does not extend retention on reads and retains per-resource ring bounds', () => {
    for (let i = 0; i < 350; i++) {
      nginx('host', String(i));
      daemon('node');
    }
    expect(getNginxLogHistory('host')).toHaveLength(300);
    expect(getDaemonLogHistory('node')).toHaveLength(300);
    vi.setSystemTime(Date.now() + LOG_HISTORY_IDLE_TTL_MS);
    expect(getNginxLogHistory('host')).toEqual([]);
    expect(getDaemonLogHistory('node')).toEqual([]);
  });
  it('reset releases buffers and sweep', () => {
    nginx('host');
    daemon('node');
    resetNginxLogHistoryForTest();
    expect(getNginxLogHistory('host')).toEqual([]);
    expect(getDaemonLogHistory('node')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
