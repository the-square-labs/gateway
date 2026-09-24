import type { RelayedDaemonLogEntry, RelayedLogEntry } from '@/modules/monitoring/log-relay.service.js';

/** Filters shared by the node log SSE routes and the AI/MCP node log snapshots. */
export const NODE_LOG_HISTORY_LIMIT = 300;

export function splitLogFilterList(value: string | undefined, normalize: (item: string) => string): string[] {
  return (
    value
      ?.split(',')
      .map((item) => normalize(item.trim()))
      .filter(Boolean) ?? []
  );
}

export function daemonLogMatcher(filters: { levels: string[]; search: string }) {
  const search = filters.search.toLowerCase();
  return (entry: RelayedDaemonLogEntry): boolean => {
    if (filters.levels.length > 0 && !filters.levels.includes((entry.level || '').toLowerCase())) return false;
    if (search && !entry.message?.toLowerCase().includes(search) && !entry.component?.toLowerCase().includes(search))
      return false;
    return true;
  };
}

export function nginxLogMatcher(filters: { hostIds: ReadonlySet<string>; search: string; statuses: string[] }) {
  const search = filters.search.toLowerCase();
  return (entry: RelayedLogEntry): boolean => {
    if (!filters.hostIds.has(entry.hostId)) return false;
    if (
      search &&
      !entry.path?.toLowerCase().includes(search) &&
      !entry.remoteAddr?.includes(search) &&
      !entry.raw?.toLowerCase().includes(search)
    )
      return false;
    if (filters.statuses.length > 0) {
      const code = entry.status;
      const isError = entry.logType === 'error';
      const matches = filters.statuses.some((f) => {
        if (f === 'error') return isError;
        if (isError) return false;
        if (f === '2xx') return code >= 200 && code < 300;
        if (f === '3xx') return code >= 300 && code < 400;
        if (f === '4xx') return code >= 400 && code < 500;
        if (f === '5xx') return code >= 500;
        return false;
      });
      if (!matches) return false;
    }
    return true;
  };
}

/** Identity of one nginx log line, used to drop the replayed tail duplicates of buffered history. */
export function nginxLogEntryKey(entry: RelayedLogEntry): string {
  return [
    entry.hostId,
    entry.logType,
    entry.timestamp,
    entry.remoteAddr,
    entry.method,
    entry.path,
    entry.status,
    entry.bodyBytesSent,
    entry.raw,
    entry.level,
  ].join('\u0000');
}
