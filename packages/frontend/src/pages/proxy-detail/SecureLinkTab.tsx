import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Ban,
  CheckCircle2,
  Clock3,
  Gauge,
  Network,
  ShieldCheck,
  Timer,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import { formatBytes, formatDateTime } from "@/lib/utils";
import { api } from "@/services/api";
import type { ProxyAdditionalSecureLinkRuntime, ProxySecureLinkStatus } from "@/types";

const MAX_HISTORY = 60;
// Match the focused cadence of ordinary node monitoring. The backend also
// records every active Secure Link every 10s when no page is open.
const POLL_INTERVAL_MS = 2000;

interface RuntimeSample {
  at: number;
  runtime: ProxySecureLinkStatus["runtime"];
  traffic: ProxySecureLinkStatus["traffic"];
}

function counter(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function rollingRate(history: RuntimeSample[], pick: (sample: RuntimeSample) => number): number[] {
  if (history.length < 2) return history.length ? [0] : [];
  return history.slice(1).map((sample, index) => {
    const previous = history[index];
    const elapsedSeconds = Math.max(0.001, (sample.at - previous.at) / 1000);
    return Math.max(0, pick(sample) - pick(previous)) / elapsedSeconds;
  });
}

function latest(values: number[]) {
  return values.at(-1) ?? 0;
}

function duration(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "0 ms";
  if (milliseconds < 1) return `${Math.round(milliseconds * 1000)} µs`;
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}

function AdditionalLinkRuntimeSection({ link }: { link: ProxyAdditionalSecureLinkRuntime }) {
  const history = link.history.slice(-MAX_HISTORY).map((sample) => ({
    at: new Date(sample.timestamp).getTime(),
    runtime: sample.runtime,
    traffic: null,
  }));
  const runtime = link.runtime;
  const activeHistory = history.map((sample) => counter(sample.runtime?.activeStreams));
  const openedRateHistory = rollingRate(history, (sample) => counter(sample.runtime?.openedTotal));
  const sourceToTargetRateHistory = rollingRate(history, (sample) =>
    counter(sample.runtime?.sourceToTargetBytes)
  );
  const targetToSourceRateHistory = rollingRate(history, (sample) =>
    counter(sample.runtime?.targetToSourceBytes)
  );
  const failedRateHistory = rollingRate(history, (sample) => counter(sample.runtime?.failedTotal));
  const throttledRateHistory = rollingRate(history, (sample) =>
    counter(sample.runtime?.throttledTotal)
  );
  const completed = counter(runtime?.completedTotal);
  const failed = counter(runtime?.failedTotal);
  const successPercent =
    completed > 0 ? clampPercent(((completed - failed) / completed) * 100) : 100;
  const successHistory = history.map((sample) => {
    const sampleCompleted = counter(sample.runtime?.completedTotal);
    const sampleFailed = counter(sample.runtime?.failedTotal);
    return sampleCompleted > 0
      ? clampPercent(((sampleCompleted - sampleFailed) / sampleCompleted) * 100)
      : 100;
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 border border-border bg-card p-3 text-sm">
        <span className="font-medium">{link.name}</span>
        <Badge
          variant={
            link.status === "active"
              ? "success"
              : link.status === "provisioning"
                ? "warning"
                : "destructive"
          }
        >
          {link.status.replace("_", " ")}
        </Badge>
        <span className="text-muted-foreground">
          {link.forwardScheme.toUpperCase()} · {link.targetContainer}
        </span>
      </div>

      {runtime ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Active streams"
              value={counter(runtime.activeStreams).toLocaleString()}
              icon={Activity}
              history={activeHistory}
              color="#3b82f6"
              subtitle="Current streams on this binding"
            />
            <StatCard
              label="New streams"
              value={`${latest(openedRateHistory).toFixed(1)}/s`}
              icon={Zap}
              history={openedRateHistory}
              color="#06b6d4"
              subtitle={`${counter(runtime.openedTotal).toLocaleString()} opened since Relay start`}
            />
            <StatCard
              label="Source → target"
              value={`${formatBytes(latest(sourceToTargetRateHistory))}/s`}
              icon={ArrowUpFromLine}
              history={sourceToTargetRateHistory}
              color="#8b5cf6"
              subtitle={`${formatBytes(counter(runtime.sourceToTargetBytes))} transferred`}
            />
            <StatCard
              label="Target → source"
              value={`${formatBytes(latest(targetToSourceRateHistory))}/s`}
              icon={ArrowDownToLine}
              history={targetToSourceRateHistory}
              color="#ec4899"
              subtitle={`${formatBytes(counter(runtime.targetToSourceBytes))} transferred`}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Open success"
              value={`${successPercent.toFixed(1)}%`}
              icon={ShieldCheck}
              history={successHistory}
              sparklineMax={100}
              progress={{
                percent: successPercent,
                color: successPercent >= 99 ? "#22c55e" : "#f59e0b",
              }}
              color="#22c55e"
              subtitle={`${Math.max(0, completed - failed).toLocaleString()} successful completions`}
            />
            <StatCard
              label="Setup p95"
              value={duration(counter(runtime.setupLatencyP95Ms))}
              icon={Timer}
              history={history.map((sample) => counter(sample.runtime?.setupLatencyP95Ms))}
              color="#f59e0b"
              subtitle="OpenTunnel to both peers ready"
            />
            <StatCard
              label="Average duration"
              value={duration(counter(runtime.averageDurationMs))}
              icon={Clock3}
              history={history.map((sample) => counter(sample.runtime?.averageDurationMs))}
              color="#a855f7"
              subtitle={`${completed.toLocaleString()} completed streams`}
            />
            <StatCard
              label="Admission rejects"
              value={counter(runtime.throttledTotal).toLocaleString()}
              icon={Ban}
              history={throttledRateHistory}
              color="#ef4444"
              subtitle={
                latest(throttledRateHistory) > 0
                  ? `${latest(throttledRateHistory).toFixed(1)}/s currently`
                  : `${latest(failedRateHistory).toFixed(1)}/s tunnel failures`
              }
            />
          </div>
        </>
      ) : (
        <div className="border border-border bg-card p-4 text-sm text-muted-foreground">
          {link.lastError || "Route telemetry is not available yet."}
        </div>
      )}
    </div>
  );
}

export function SecureLinkTab({ hostId }: { hostId: string }) {
  const [history, setHistory] = useState<RuntimeSample[]>([]);
  const [link, setLink] = useState<ProxySecureLinkStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const record = useCallback((next: ProxySecureLinkStatus) => {
    setLink(next);
    setHistory(
      next.history.slice(-MAX_HISTORY).map((sample) => ({
        at: new Date(sample.timestamp).getTime(),
        runtime: sample.runtime,
        traffic: sample.traffic,
      }))
    );
  }, []);

  useEffect(() => {
    let active = true;
    let loading = false;
    setLink(null);
    setHistory([]);
    setLoadError(null);
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const next = await api.getProxySecureLinkStatus(hostId);
        if (active) {
          setLoadError(null);
          record(next);
        }
      } catch (error) {
        if (active) {
          setLoadError(
            error instanceof Error ? error.message : "Failed to load Secure Link runtime"
          );
        }
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [hostId, record]);

  if (!link && loadError) {
    return (
      <div className="border border-destructive/50 bg-card p-4 text-sm text-destructive">
        {loadError}
      </div>
    );
  }

  if (!link) {
    return (
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-32" />
        ))}
      </div>
    );
  }

  const runtime = link.runtime;
  const traffic = link.traffic;
  const additionalLinks = link.additionalLinks ?? [];
  const activeHistory = history.map((sample) => counter(sample.runtime?.activeStreams));
  const openedRateHistory = rollingRate(history, (sample) => counter(sample.runtime?.openedTotal));
  const sourceToTargetRateHistory = rollingRate(history, (sample) =>
    counter(sample.runtime?.sourceToTargetBytes)
  );
  const targetToSourceRateHistory = rollingRate(history, (sample) =>
    counter(sample.runtime?.targetToSourceBytes)
  );
  const failedRateHistory = rollingRate(history, (sample) => counter(sample.runtime?.failedTotal));
  const throttledRateHistory = rollingRate(history, (sample) =>
    counter(sample.runtime?.throttledTotal)
  );
  const completed = counter(runtime?.completedTotal);
  const failed = counter(runtime?.failedTotal);
  const successPercent =
    completed > 0 ? clampPercent(((completed - failed) / completed) * 100) : 100;
  const successHistory = history.map((sample) => {
    const sampleCompleted = counter(sample.runtime?.completedTotal);
    const sampleFailed = counter(sample.runtime?.failedTotal);
    return sampleCompleted > 0
      ? clampPercent(((sampleCompleted - sampleFailed) / sampleCompleted) * 100)
      : 100;
  });
  const statusCodes = {
    s2xx: counter(traffic?.statusCodes?.s2xx),
    s3xx: counter(traffic?.statusCodes?.s3xx),
    s4xx: counter(traffic?.statusCodes?.s4xx),
    s5xx: counter(traffic?.statusCodes?.s5xx),
  };
  const httpTotal = Object.values(statusCodes).reduce((sum, value) => sum + value, 0);
  const httpSuccessPercent =
    httpTotal > 0 ? clampPercent((statusCodes.s2xx / httpTotal) * 100) : 100;
  const rateLimitRps = counter(link.rateLimit?.requestsPerSecond);
  const clientLimitPercent =
    traffic && link.rateLimit?.enabled && rateLimitRps > 0
      ? clampPercent((counter(traffic.busiestClientRps) / rateLimitRps) * 100)
      : 0;
  const healthy =
    link.state === "active" &&
    link.sourceNode?.status === "online" &&
    link.targetNode?.status === "online";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 border border-border bg-card p-3 text-sm">
        <span className="font-medium">Host ↔ daemon Secure Link</span>
        <Badge
          variant={healthy ? "success" : link.state === "provisioning" ? "warning" : "destructive"}
        >
          {link.state ?? "unavailable"}
        </Badge>
        <Badge variant="secondary">{link.transport ?? "unknown transport"}</Badge>
        <Badge variant="secondary">generation {link.generation ?? "-"}</Badge>
      </div>

      {link.telemetryStale === true && (
        <div
          className="flex items-start gap-2 border border-warning/30 bg-warning/5 p-3"
          role="status"
        >
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 h-4 w-4 shrink-0 text-warning-foreground"
          />
          <p className="text-sm text-warning-foreground">
            Telemetry is stale. Showing the last complete sample
            {link.telemetrySampledAt ? ` from ${formatDateTime(link.telemetrySampledAt)}` : ""}.
          </p>
        </div>
      )}

      <section>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-muted-foreground">Link traffic</h3>
          {link.healthCheck.enabled && (
            <Badge variant="secondary">E2E probe every {link.healthCheck.intervalSeconds}s</Badge>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Active streams"
            value={String(runtime?.activeStreams ?? 0)}
            icon={Activity}
            history={activeHistory}
            color="#3b82f6"
            subtitle="Current streams on this route"
          />
          <StatCard
            label="New streams"
            value={`${latest(openedRateHistory).toFixed(1)}/s`}
            icon={Zap}
            history={openedRateHistory}
            color="#06b6d4"
            subtitle={`${counter(runtime?.openedTotal).toLocaleString()} opened since Relay start`}
          />
          <StatCard
            label="Source → target"
            value={`${formatBytes(latest(sourceToTargetRateHistory))}/s`}
            icon={ArrowUpFromLine}
            history={sourceToTargetRateHistory}
            color="#8b5cf6"
            subtitle={`${formatBytes(counter(runtime?.sourceToTargetBytes))} transferred`}
          />
          <StatCard
            label="Target → source"
            value={`${formatBytes(latest(targetToSourceRateHistory))}/s`}
            icon={ArrowDownToLine}
            history={targetToSourceRateHistory}
            color="#ec4899"
            subtitle={`${formatBytes(counter(runtime?.targetToSourceBytes))} transferred`}
          />
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-muted-foreground">Tunnel reliability</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Open success"
            value={`${successPercent.toFixed(1)}%`}
            icon={ShieldCheck}
            history={successHistory}
            sparklineMax={100}
            progress={{
              percent: successPercent,
              color: successPercent >= 99 ? "#22c55e" : "#f59e0b",
            }}
            color="#22c55e"
            subtitle={`${Math.max(0, completed - failed).toLocaleString()} successful completions`}
          />
          <StatCard
            label="Setup p95"
            value={duration(runtime?.setupLatencyP95Ms ?? 0)}
            icon={Timer}
            history={history.map((sample) => counter(sample.runtime?.setupLatencyP95Ms))}
            color="#f59e0b"
            subtitle="OpenTunnel to both peers ready"
          />
          <StatCard
            label="Average duration"
            value={duration(runtime?.averageDurationMs ?? 0)}
            icon={Clock3}
            history={history.map((sample) => counter(sample.runtime?.averageDurationMs))}
            color="#a855f7"
            subtitle={`${completed.toLocaleString()} completed streams`}
          />
          <StatCard
            label="Admission rejects"
            value={counter(runtime?.throttledTotal).toLocaleString()}
            icon={Ban}
            history={throttledRateHistory}
            color="#ef4444"
            subtitle={
              latest(throttledRateHistory) > 0
                ? `${latest(throttledRateHistory).toFixed(1)}/s currently`
                : `${latest(failedRateHistory).toFixed(1)}/s tunnel failures`
            }
          />
        </div>
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-muted-foreground">HTTP traffic</h3>
          {traffic?.sampleTruncated && <Badge variant="warning">sampled tail</Badge>}
        </div>
        {traffic ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Requests"
              value={`${counter(traffic.requestsPerSecond).toFixed(1)}/s`}
              icon={Network}
              history={history.map((sample) => counter(sample.traffic?.requestsPerSecond))}
              color="#3b82f6"
              subtitle={`${counter(traffic.totalRequests).toLocaleString()} in ${counter(traffic.windowSeconds)}s window`}
            />
            <StatCard
              label="2xx success"
              value={`${httpSuccessPercent.toFixed(1)}%`}
              icon={CheckCircle2}
              history={history.map((sample) => {
                const sampleTraffic = sample.traffic;
                if (!sampleTraffic) return 100;
                const sample2xx = counter(sampleTraffic.statusCodes?.s2xx);
                const total = [
                  sample2xx,
                  counter(sampleTraffic.statusCodes?.s3xx),
                  counter(sampleTraffic.statusCodes?.s4xx),
                  counter(sampleTraffic.statusCodes?.s5xx),
                ].reduce((sum, value) => sum + value, 0);
                return total > 0 ? clampPercent((sample2xx / total) * 100) : 100;
              })}
              sparklineMax={100}
              progress={{
                percent: httpSuccessPercent,
                color: httpSuccessPercent >= 99 ? "#22c55e" : "#f59e0b",
              }}
              color="#22c55e"
              subtitle={`${statusCodes.s2xx.toLocaleString()} successful responses`}
            />
            <StatCard
              label="Upstream p95"
              value={duration(counter(traffic.p95ResponseTime) * 1000)}
              icon={Timer}
              history={history.map((sample) => counter(sample.traffic?.p95ResponseTime) * 1000)}
              color="#8b5cf6"
              subtitle={`${duration(counter(traffic.avgResponseTime) * 1000)} average`}
            />
            <StatCard
              label="Response bandwidth"
              value={`${formatBytes(counter(traffic.bytesPerSecond))}/s`}
              icon={ArrowDownToLine}
              history={history.map((sample) => counter(sample.traffic?.bytesPerSecond))}
              color="#ec4899"
              subtitle={`${formatBytes(counter(traffic.totalBytes))} in current window`}
            />
            <StatCard
              label="4xx responses"
              value={statusCodes.s4xx.toLocaleString()}
              icon={X}
              history={history.map((sample) => counter(sample.traffic?.statusCodes?.s4xx))}
              color="#f59e0b"
              subtitle={`${counter(traffic.windowSeconds)}s rolling window`}
            />
            <StatCard
              label="5xx responses"
              value={statusCodes.s5xx.toLocaleString()}
              icon={X}
              history={history.map((sample) => counter(sample.traffic?.statusCodes?.s5xx))}
              color="#ef4444"
              subtitle={`${counter(traffic.windowSeconds)}s rolling window`}
            />
            <StatCard
              label="Hottest client"
              value={`${counter(traffic.busiestClientRps).toLocaleString()} r/s`}
              icon={Gauge}
              history={history.map((sample) => counter(sample.traffic?.busiestClientRps))}
              sparklineMax={link.rateLimit?.enabled && rateLimitRps > 0 ? rateLimitRps : undefined}
              progress={
                link.rateLimit?.enabled
                  ? {
                      percent: clientLimitPercent,
                      color: clientLimitPercent >= 90 ? "#ef4444" : "#06b6d4",
                    }
                  : undefined
              }
              color="#06b6d4"
              subtitle={
                link.rateLimit?.enabled
                  ? `of ${rateLimitRps.toLocaleString()} r/s per-IP limit`
                  : "Per-IP rate limit disabled"
              }
            />
            <StatCard
              label="Last request"
              value={traffic.lastRequestAt ? formatDateTime(traffic.lastRequestAt) : "No traffic"}
              icon={Clock3}
              color="#64748b"
              valueClassName="text-base"
              subtitle={
                traffic.sampleTruncated ? "High-volume sampled window" : "Complete rolling window"
              }
            />
          </div>
        ) : (
          <div className="border border-border bg-card p-4 text-sm text-muted-foreground">
            Per-host HTTP telemetry is unavailable. Update or reconnect the source Nginx daemon.
          </div>
        )}
      </section>

      {additionalLinks.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-muted-foreground">Additional links</h3>
          {additionalLinks.map((additionalLink) => (
            <AdditionalLinkRuntimeSection key={additionalLink.id} link={additionalLink} />
          ))}
        </section>
      )}
    </div>
  );
}
