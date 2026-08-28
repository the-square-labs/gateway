import { describe, expect, it } from 'vitest';
import type { RelayedLogEntry } from './log-relay.service.js';
import { proxyLogEntryKey, selectProxyLogHistoryPage } from './proxy-logs.ws.js';

function entry(index: number): RelayedLogEntry {
  return {
    nodeId: 'node-1',
    hostId: 'host-1',
    timestamp: `2026-08-28T00:00:${String(index).padStart(3, '0')}Z`,
    remoteAddr: '127.0.0.1',
    method: 'GET',
    path: `/entry-${index}`,
    status: 200,
    bodyBytesSent: '0',
    raw: `entry-${index}`,
    logType: 'access',
    level: '',
  };
}

describe('selectProxyLogHistoryPage', () => {
  it('pages correctly when pending contains the complete history replay', () => {
    const snapshot = Array.from({ length: 401 }, (_, index) => entry(index));
    const pending = [...snapshot];

    const page = selectProxyLogHistoryPage(
      snapshot,
      pending,
      proxyLogEntryKey(entry(201)),
      proxyLogEntryKey(entry(400)),
      200
    );

    expect(page.entries).toEqual(snapshot.slice(1, 201));
    expect(page.liveEntries).toEqual([]);
    expect(page.hasMore).toBe(true);
  });

  it('separates live rows included in or arriving after the replay snapshot', () => {
    const history = Array.from({ length: 401 }, (_, index) => entry(index));
    const liveInSnapshot = entry(401);
    const liveAfterAck = entry(402);
    const errorInSnapshot = { ...entry(403), logType: 'error', raw: 'error-403' };
    const snapshot = [...history, liveInSnapshot, errorInSnapshot];
    const pending = [...snapshot, liveAfterAck];

    const page = selectProxyLogHistoryPage(
      snapshot,
      pending,
      proxyLogEntryKey(entry(201)),
      proxyLogEntryKey(entry(400)),
      200
    );

    expect(page.entries).toEqual(history.slice(1, 201));
    expect(page.liveEntries).toEqual([liveInSnapshot, errorInSnapshot, liveAfterAck]);
    expect(page.hasMore).toBe(true);
  });

  it('deduplicates repeated post-snapshot pending delivery', () => {
    const pending = [entry(11), entry(11)];
    const page = selectProxyLogHistoryPage(
      [entry(1), entry(10)],
      pending,
      proxyLogEntryKey(entry(10)),
      proxyLogEntryKey(entry(10)),
      200
    );

    expect(page.entries).toEqual([entry(1)]);
    expect(page.liveEntries).toEqual([entry(11)]);
  });
});
