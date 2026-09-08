import { EventEmitter } from 'node:events';

export interface RelayedLogEntry {
  nodeId: string;
  hostId: string;
  timestamp: string;
  remoteAddr: string;
  method: string;
  path: string;
  status: number;
  bodyBytesSent: string;
  raw: string;
  logType: string; // "access" or "error"
  level: string; // for error logs
}

export interface RelayedDaemonLogEntry {
  nodeId: string;
  timestamp: string;
  level: string;
  message: string;
  component: string;
  fields: Record<string, string>;
}

export interface NginxLogSubscribeAck {
  nodeId: string;
  hostId: string;
}

export const NGINX_LOG_SUBSCRIBE_ACK_EVENT = 'subscribe-ack';

/**
 * In-memory relay for nginx access log entries.
 * gRPC log-stream handler emits entries here, SSE endpoints subscribe.
 */
export const logRelay = new EventEmitter();
logRelay.setMaxListeners(100);

const NGINX_LOG_BUFFER_SIZE = 300;
const nginxLogBuffers = new Map<string, RelayedLogEntry[]>();
export const LOG_HISTORY_MAX_KEYS = 1024;
export const LOG_HISTORY_IDLE_TTL_MS = 60 * 60 * 1000;
const historyActivity = new Map<string, number>();
let historySweep: ReturnType<typeof setInterval> | null = null;

function evictHistory(key: string): void {
  historyActivity.delete(key);
  if (key.startsWith('nginx:')) nginxLogBuffers.delete(key.slice(6));
  else daemonLogBuffers.delete(key.slice(7));
}

function pruneHistory(): void {
  const cutoff = Date.now() - LOG_HISTORY_IDLE_TTL_MS;
  for (const [key, lastWrite] of historyActivity) {
    if (lastWrite <= cutoff) evictHistory(key);
  }
  if (historyActivity.size === 0 && historySweep) {
    clearInterval(historySweep);
    historySweep = null;
  }
}

function touchHistory(key: string): void {
  pruneHistory();
  historyActivity.delete(key);
  historyActivity.set(key, Date.now());
  while (historyActivity.size > LOG_HISTORY_MAX_KEYS) {
    evictHistory(historyActivity.keys().next().value!);
  }
  if (!historySweep) {
    historySweep = setInterval(pruneHistory, 60_000);
    historySweep.unref?.();
  }
}

function nginxLogEntryKey(entry: RelayedLogEntry): string {
  return [
    entry.nodeId,
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

/** Buffer proxy-host nginx log entries for replay on SSE connect. */
logRelay.on('log', (entry: RelayedLogEntry) => {
  touchHistory(`nginx:${entry.hostId}`);
  let buf = nginxLogBuffers.get(entry.hostId);
  if (!buf) {
    buf = [];
    nginxLogBuffers.set(entry.hostId, buf);
  }
  const key = nginxLogEntryKey(entry);
  if (buf.some((item) => nginxLogEntryKey(item) === key)) return;
  buf.push(entry);
  if (buf.length > NGINX_LOG_BUFFER_SIZE) {
    buf.splice(0, buf.length - NGINX_LOG_BUFFER_SIZE);
  }
});

/** Get buffered nginx logs for a proxy host. */
export function getNginxLogHistory(hostId: string): RelayedLogEntry[] {
  pruneHistory();
  return [...(nginxLogBuffers.get(hostId) ?? [])];
}

export function resetNginxLogHistoryForTest(): void {
  nginxLogBuffers.clear();
  daemonLogBuffers.clear();
  historyActivity.clear();
  if (historySweep) clearInterval(historySweep);
  historySweep = null;
}

/**
 * In-memory relay for daemon operational log entries with a per-node ring buffer.
 * gRPC control handler emits entries here, SSE endpoints subscribe.
 */
export const daemonLogRelay = new EventEmitter();
daemonLogRelay.setMaxListeners(100);

const DAEMON_LOG_BUFFER_SIZE = 300;
const daemonLogBuffers = new Map<string, RelayedDaemonLogEntry[]>();

/** Buffer daemon log entries per node for replay on SSE connect. */
daemonLogRelay.on('log', (entry: RelayedDaemonLogEntry) => {
  touchHistory(`daemon:${entry.nodeId}`);
  let buf = daemonLogBuffers.get(entry.nodeId);
  if (!buf) {
    buf = [];
    daemonLogBuffers.set(entry.nodeId, buf);
  }
  buf.push(entry);
  if (buf.length > DAEMON_LOG_BUFFER_SIZE) {
    buf.splice(0, buf.length - DAEMON_LOG_BUFFER_SIZE);
  }
});

/** Get buffered daemon logs for a node (for replay on SSE connect). */
export function getDaemonLogHistory(nodeId: string): RelayedDaemonLogEntry[] {
  pruneHistory();
  return [...(daemonLogBuffers.get(nodeId) ?? [])];
}
