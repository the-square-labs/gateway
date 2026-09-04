import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Ban,
  Clock3,
  ShieldCheck,
  Timer,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import { formatBytes } from "@/lib/utils";
import { api } from "@/services/api";
import type { ManagedDatabaseBinding, ManagedDatabaseBindingRuntime } from "@/types";

const MAX_HISTORY = 60;
const POLL_INTERVAL_MS = 2000;

export interface ContainerDatabaseLink {
  database: Pick<import("@/types").ManagedDatabase, "id" | "name" | "type">;
  binding: Pick<
    ManagedDatabaseBinding,
    | "id"
    | "managedDatabaseId"
    | "targetNodeId"
    | "targetType"
    | "targetResourceId"
    | "status"
    | "lastError"
  >;
}

interface RuntimeSample {
  at: number;
  runtime: ManagedDatabaseBindingRuntime;
}

interface LinkRuntimeState {
  runtime: ManagedDatabaseBindingRuntime | null;
  history: RuntimeSample[];
  telemetryUnavailable: boolean;
  loading: boolean;
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

function runtimeCards(runtime: ManagedDatabaseBindingRuntime, history: RuntimeSample[]) {
  const activeHistory = history.map((sample) => counter(sample.runtime.activeStreams));
  const openedRateHistory = rollingRate(history, (sample) => counter(sample.runtime.openedTotal));
  const sourceToTargetRateHistory = rollingRate(history, (sample) =>
    counter(sample.runtime.sourceToTargetBytes)
  );
  const targetToSourceRateHistory = rollingRate(history, (sample) =>
    counter(sample.runtime.targetToSourceBytes)
  );
  const failedRateHistory = rollingRate(history, (sample) => counter(sample.runtime.failedTotal));
  const throttledRateHistory = rollingRate(history, (sample) =>
    counter(sample.runtime.throttledTotal)
  );
  const completed = counter(runtime.completedTotal);
  const failed = counter(runtime.failedTotal);
  const successPercent =
    completed > 0 ? clampPercent(((completed - failed) / completed) * 100) : 100;
  const successHistory = history.map((sample) => {
    const sampleCompleted = counter(sample.runtime.completedTotal);
    const sampleFailed = counter(sample.runtime.failedTotal);
    return sampleCompleted > 0
      ? clampPercent(((sampleCompleted - sampleFailed) / sampleCompleted) * 100)
      : 100;
  });

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Active streams"
        value={counter(runtime.activeStreams).toLocaleString()}
        icon={Activity}
        history={activeHistory}
        color="#3b82f6"
        subtitle="Current streams on this link"
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
        history={history.map((sample) => counter(sample.runtime.setupLatencyP95Ms))}
        color="#f59e0b"
        subtitle="OpenTunnel to both peers ready"
      />
      <StatCard
        label="Average duration"
        value={duration(counter(runtime.averageDurationMs))}
        icon={Clock3}
        history={history.map((sample) => counter(sample.runtime.averageDurationMs))}
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
  );
}

function emptyRuntimeCards() {
  const cards = [
    ["Active streams", Activity],
    ["New streams", Zap],
    ["Source → target", ArrowUpFromLine],
    ["Target → source", ArrowDownToLine],
    ["Open success", ShieldCheck],
    ["Setup p95", Timer],
    ["Average duration", Clock3],
    ["Admission rejects", Ban],
  ] as const;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map(([label, icon]) => (
        <StatCard
          key={label}
          label={label}
          value="—"
          icon={icon}
          history={[]}
          subtitle="Waiting for runtime telemetry"
        />
      ))}
    </div>
  );
}

export function LinkRuntimeTab({
  links,
  onHealthChange,
}: {
  links: ContainerDatabaseLink[];
  onHealthChange?: (down: boolean) => void;
}) {
  const [states, setStates] = useState<Record<string, LinkRuntimeState>>({});
  const generationRef = useRef(0);
  const orderedLinks = useMemo(
    () =>
      [...links].sort(
        (left, right) =>
          left.database.name.localeCompare(right.database.name) ||
          left.binding.id.localeCompare(right.binding.id)
      ),
    [links]
  );
  const linksRef = useRef(orderedLinks);
  linksRef.current = orderedLinks;
  const linkIds = orderedLinks.map(({ binding }) => binding.id).join("|");

  useEffect(() => {
    const generation = ++generationRef.current;
    const activeLinkIds = new Set(linkIds.split("|").filter(Boolean));
    let inFlight = false;
    setStates((current) =>
      Object.fromEntries(
        linksRef.current
          .filter(({ binding }) => activeLinkIds.has(binding.id))
          .map(({ binding }) => [
            binding.id,
            current[binding.id] ?? {
              runtime: null,
              history: [],
              telemetryUnavailable: false,
              loading: true,
            },
          ])
      )
    );
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const currentLinks = linksRef.current.filter(({ binding }) => binding.status !== "error");
        const results = await Promise.allSettled(
          currentLinks.map(async ({ database, binding }) => ({
            bindingId: binding.id,
            status: await api.getManagedDatabaseBindingRuntime(database.id, binding.id),
          }))
        );
        if (generation !== generationRef.current) return;
        const sampledAt = Date.now();
        setStates((current) => {
          if (generation !== generationRef.current) return current;
          const next: Record<string, LinkRuntimeState> = {};
          for (const [index, result] of results.entries()) {
            const bindingId = currentLinks[index]!.binding.id;
            const previous = current[bindingId];
            if (result.status === "fulfilled") {
              const runtime = result.value.status.runtime;
              next[bindingId] = {
                runtime,
                history: runtime
                  ? [...(previous?.history ?? []), { at: sampledAt, runtime }].slice(-MAX_HISTORY)
                  : (previous?.history ?? []),
                telemetryUnavailable: false,
                loading: false,
              };
            } else {
              next[bindingId] = {
                runtime: previous?.runtime ?? null,
                history: previous?.history ?? [],
                telemetryUnavailable: true,
                loading: false,
              };
            }
          }
          return next;
        });
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      generationRef.current += 1;
      window.clearInterval(timer);
    };
  }, [linkIds]);

  const hasDownLink = orderedLinks.some(({ binding }) => binding.status === "error");
  useEffect(() => {
    onHealthChange?.(hasDownLink);
  }, [hasDownLink, onHealthChange]);

  return (
    <div className="space-y-6">
      {orderedLinks.map(({ database, binding }) => {
        const state = states[binding.id];
        if (binding.status === "error") return null;
        return (
          <section key={binding.id} className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-muted-foreground">{database.name}</h3>
              <Badge variant="secondary">{database.type}</Badge>
              <Badge
                variant={
                  binding.status === "ready"
                    ? "success"
                    : binding.status === "creating" || binding.status === "deleting"
                      ? "warning"
                      : "destructive"
                }
              >
                {binding.status}
              </Badge>
            </div>

            {state?.loading || !state ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {Array.from({ length: 8 }, (_, index) => (
                  <Skeleton key={index} className="h-32" />
                ))}
              </div>
            ) : state.runtime ? (
              <>
                {runtimeCards(state.runtime, state.history)}
                {state.telemetryUnavailable && (
                  <p className="text-xs text-muted-foreground">
                    Runtime telemetry is temporarily unavailable. Showing the last confirmed sample.
                  </p>
                )}
              </>
            ) : state.telemetryUnavailable ? (
              <p className="text-xs text-muted-foreground">
                Runtime telemetry is temporarily unavailable.
              </p>
            ) : (
              emptyRuntimeCards()
            )}
          </section>
        );
      })}
    </div>
  );
}
