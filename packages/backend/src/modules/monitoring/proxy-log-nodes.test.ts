import { describe, expect, it } from 'vitest';
import type { RelayedLogEntry } from './log-relay.service.js';
import { mergeNodeLogEntries, nginxLogTime } from './proxy-log-nodes.js';

const line = (nodeId: string, timestamp: string, path: string): RelayedLogEntry => ({
  nodeId,
  hostId: 'route-1',
  timestamp,
  remoteAddr: '192.0.2.1',
  method: 'GET',
  path,
  status: 200,
  bodyBytesSent: '1',
  raw: path,
  logType: 'access',
  level: '',
});

describe('route logs of an ingress group', () => {
  it('reads nginx access and error log times', () => {
    expect(nginxLogTime('28/Sep/2026:19:00:00 +0200')).toBe(Date.UTC(2026, 8, 28, 17, 0, 0));
    expect(nginxLogTime('2026/09/28 19:00:05 [error] 1#1: upstream timed out')).toBe(Date.UTC(2026, 8, 28, 19, 0, 5));
    expect(Number.isNaN(nginxLogTime('not a time'))).toBe(true);
  });

  it('merges the members lines by time and keeps each member order for unreadable times', () => {
    const merged = mergeNodeLogEntries([
      [
        line('a', '28/Sep/2026:19:00:00 +0000', '/a1'),
        line('a', 'garbled', '/a2'),
        line('a', '28/Sep/2026:19:00:09 +0000', '/a3'),
      ],
      [line('b', '28/Sep/2026:19:00:05 +0000', '/b1'), line('b', '28/Sep/2026:19:00:00 +0000', '/b0')],
    ]);
    expect(merged.map((entry) => entry.path)).toEqual(['/a1', '/a2', '/b0', '/b1', '/a3']);
  });

  it('returns one node lines unchanged', () => {
    const lines = [line('a', 'x', '/1'), line('a', 'y', '/2')];
    expect(mergeNodeLogEntries([lines])).toEqual(lines);
  });
});
