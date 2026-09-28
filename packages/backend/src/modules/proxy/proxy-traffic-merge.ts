import type { ProxyHostTrafficRuntime } from './proxy.service.core.js';

/**
 * HTTP telemetry of a route on an ingress group: every member serves part of the traffic, so the route's numbers are
 * the sum over members (counts, bytes, rates), the request-weighted average response time, the worst p95 and the
 * newest request. A single report is returned unchanged.
 */
export function mergeTrafficRuntimes(reports: readonly ProxyHostTrafficRuntime[]): ProxyHostTrafficRuntime | null {
  if (reports.length === 0) return null;
  if (reports.length === 1) return reports[0]!;
  const sum = (pick: (report: ProxyHostTrafficRuntime) => number) =>
    reports.reduce((total, report) => total + (Number.isFinite(pick(report)) ? pick(report) : 0), 0);
  const totalRequests = sum((report) => report.totalRequests);
  const lastRequestAt = reports
    .map((report) => report.lastRequestAt)
    .filter((value): value is string => typeof value === 'string')
    .sort()
    .at(-1);
  return {
    hostId: reports[0]!.hostId,
    statusCodes: {
      s2xx: sum((report) => report.statusCodes.s2xx),
      s3xx: sum((report) => report.statusCodes.s3xx),
      s4xx: sum((report) => report.statusCodes.s4xx),
      s5xx: sum((report) => report.statusCodes.s5xx),
    },
    avgResponseTime:
      totalRequests > 0 ? sum((report) => report.avgResponseTime * report.totalRequests) / totalRequests : 0,
    p95ResponseTime: Math.max(...reports.map((report) => report.p95ResponseTime || 0)),
    totalRequests,
    totalBytes: sum((report) => report.totalBytes),
    requestsPerSecond: sum((report) => report.requestsPerSecond),
    bytesPerSecond: sum((report) => report.bytesPerSecond),
    busiestClientRps: Math.max(...reports.map((report) => report.busiestClientRps || 0)),
    windowSeconds: Math.max(...reports.map((report) => report.windowSeconds || 0)),
    sampleTruncated: reports.some((report) => report.sampleTruncated),
    ...(lastRequestAt ? { lastRequestAt } : {}),
  };
}
