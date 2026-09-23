import { AlertTriangle, Loader2, RotateCw, XCircle } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  isGatewayUpdateTargetVersion,
  normalizeGatewayUpdateVersion,
  publishGatewayReload,
  reloadGatewayClient,
  subscribeGatewayReload,
} from "@/lib/gateway-update-reload";
import { formatDateTime } from "@/lib/utils";
import { api } from "@/services/api";
import { useAppStatusStore } from "@/stores/app-status";
import { useAuthStore } from "@/stores/auth";
import { useUpdateStore } from "@/stores/update";
import type { GatewayUpdateOperation } from "@/types";

export { isGatewayUpdateTargetVersion, normalizeGatewayUpdateVersion };

const VERSION_RELOAD_CHECK_INTERVAL_MS = 30_000;
/**
 * The update screen never outlasts the longest wait for running operations
 * (one hour) plus the update itself, even if the server still reports it.
 */
export const GATEWAY_UPDATE_MAX_WAIT_MS = 90 * 60_000;
/** Covers the moments before the server has registered an accepted update. */
export const GATEWAY_UPDATE_UNKNOWN_GRACE_MS = 60_000;
const GATEWAY_UPDATE_STATUS_CHECK_INTERVAL_MS = 15_000;
const MAINTENANCE_RECOVERY_CHECK_INTERVAL_MS = 5_000;
const MAINTENANCE_AUTO_RELOAD_GUARD_KEY = "gateway-maintenance-auto-reload";

export function clearMaintenanceAutoReloadGuard(): void {
  window.sessionStorage.removeItem(MAINTENANCE_AUTO_RELOAD_GUARD_KEY);
}

async function fetchGatewayCurrentVersion(): Promise<string | null> {
  try {
    // Health is intentionally outside the authenticated API rate-limit bucket.
    // A deployment detector must never be able to lock the application UI out.
    const response = await fetch("/health", {
      cache: "no-store",
      headers: { "X-Gateway-Health-Probe": "version" },
    });
    if (response.ok) {
      const payload = (await response.json()) as GatewayHealthSnapshot;
      return payload.version ?? null;
    }
  } catch {
    // A transient failure must not be interpreted as a version change.
  }
  return null;
}

function MaintenanceScreen() {
  const setMaintenanceActive = useAppStatusStore((s) => s.setMaintenanceActive);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    let consecutiveReadyChecks = 0;
    const controller = new AbortController();

    const scheduleCheck = () => {
      if (cancelled) return;
      timer = window.setTimeout(() => void checkRecovery(), MAINTENANCE_RECOVERY_CHECK_INTERVAL_MS);
    };

    const checkRecovery = async () => {
      try {
        const [healthResponse, apiResponse] = await Promise.all([
          fetch("/health", {
            cache: "no-store",
            headers: { "X-Gateway-Health-Probe": "maintenance" },
            signal: controller.signal,
          }),
          fetch("/api/setup/status", {
            cache: "no-store",
            credentials: "include",
            signal: controller.signal,
          }),
        ]);
        const health = healthResponse.ok
          ? ((await healthResponse.json()) as GatewayHealthSnapshot)
          : null;
        const ready =
          healthResponse.ok &&
          (health?.lifecycleState ?? "running") === "running" &&
          apiResponse.ok;

        consecutiveReadyChecks = ready ? consecutiveReadyChecks + 1 : 0;
        if (consecutiveReadyChecks >= 2) {
          const autoReloadAlreadyAttempted =
            window.sessionStorage.getItem(MAINTENANCE_AUTO_RELOAD_GUARD_KEY) === "1";
          if (!autoReloadAlreadyAttempted) {
            window.sessionStorage.setItem(MAINTENANCE_AUTO_RELOAD_GUARD_KEY, "1");
            window.location.reload();
          } else if (!cancelled) {
            setMaintenanceActive(false);
          }
          return;
        }
      } catch {
        consecutiveReadyChecks = 0;
      }

      scheduleCheck();
    };

    scheduleCheck();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [setMaintenanceActive]);

  return (
    <div className="fixed inset-0 z-[200] flex min-h-screen items-center justify-center bg-[#090909] px-6 text-[#f4f4f5]">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.06)] text-[#ef4444]">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <h2 className="m-0 text-lg font-semibold leading-[1.4]">Temporarily Unavailable</h2>
        <p className="mt-2 text-sm leading-[1.55] text-[#a1a1aa]">
          The backend is not responding right now. Your session is preserved.
        </p>
        <div className="mt-7 text-xs text-[#71717a]">
          Powered by{" "}
          <a
            href="https://thesquarelabs.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#a1a1aa] hover:underline"
          >
            Square Labs
          </a>
        </div>
      </div>
    </div>
  );
}

interface GatewayHealthSnapshot {
  lifecycleState?: "running" | "draining_user" | "draining_logs" | "terminating";
  version?: string | null;
}

function UpdateOperationScreen({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-[205] flex min-h-screen items-center justify-center bg-[#090909] px-6 text-[#f4f4f5]">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center border border-[rgba(234,179,8,0.35)] bg-[rgba(234,179,8,0.06)] text-[#facc15]">
          <RotateCw className="h-6 w-6 animate-spin motion-reduce:[animation-duration:1.8s]" />
        </div>
        <h2 className="m-0 text-lg font-semibold leading-[1.4]">{title}</h2>
        <p className="mt-2 text-sm leading-[1.55] text-[#a1a1aa]">{description}</p>
        {children}
        <div className="mt-7 text-xs text-[#71717a]">
          Powered by{" "}
          <a
            href="https://thesquarelabs.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#a1a1aa] hover:underline"
          >
            Square Labs
          </a>
        </div>
      </div>
    </div>
  );
}

export function buildGatewayRestartTargetUrl(targetBase: string, currentHref: string): string {
  const target = new URL(targetBase, currentHref);
  const current = new URL(currentHref);
  target.pathname = current.pathname;
  target.search = current.search;
  target.hash = current.hash;
  return target.toString();
}

/** The update waits for running orchestration operations before it restarts Gateway. */
function GatewayUpdateWaitingScreen({ operation }: { operation: GatewayUpdateOperation }) {
  const canUpdate = useAuthStore((state) => state.hasScope("admin:update"));
  const proceedWithUpdate = useUpdateStore((state) => state.proceedWithUpdate);
  const [proceeding, setProceeding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleProceed = async () => {
    setProceeding(true);
    setError(null);
    try {
      await proceedWithUpdate();
    } catch (proceedError) {
      setError(
        proceedError instanceof Error ? proceedError.message : "The update could not be started"
      );
      setProceeding(false);
    }
  };

  return (
    <UpdateOperationScreen
      title="Waiting to update Gateway"
      description={`Gateway updates to ${operation.targetVersion} as soon as running operations finish${
        operation.waitDeadline ? `, at the latest at ${formatDateTime(operation.waitDeadline)}` : ""
      }. New deployments and other operations are paused until then.`}
    >
      <ul
        aria-label="Running operations"
        className="mt-5 divide-y divide-[#27272a] border border-[#27272a] text-left text-sm"
      >
        {operation.operations.map((item) => (
          <li key={item.kind} className="flex items-center justify-between gap-4 px-3 py-2">
            <span className="text-[#d4d4d8]">{item.label}</span>
            <span className="font-medium tabular-nums text-[#f4f4f5]">{item.count}</span>
          </li>
        ))}
      </ul>
      {canUpdate && (
        <div className="mt-5 space-y-2">
          <Button className="w-full" onClick={handleProceed} disabled={proceeding}>
            {proceeding && <Loader2 className="animate-spin" />}
            Update now
          </Button>
          <p className="text-xs leading-[1.5] text-[#71717a]">
            Updating now interrupts these operations. Gateway resumes or reconciles them after the
            restart.
          </p>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
      )}
    </UpdateOperationScreen>
  );
}

function GatewayOperationScreen() {
  const updatingActive = useAppStatusStore((s) => s.gatewayUpdatingActive);
  const gatewayOperation = useUpdateStore((state) => state.status?.gatewayOperation ?? null);
  const targetVersion = useAppStatusStore((s) => s.gatewayUpdatingTargetVersion);
  const restartTargetUrl = useAppStatusStore((s) => s.gatewayRestartTargetUrl);
  const clearGatewayUpdating = useAppStatusStore((s) => s.clearGatewayUpdating);
  const clearGatewayRestarting = useAppStatusStore((s) => s.clearGatewayRestarting);
  const setGatewayUpdateError = useAppStatusStore((s) => s.setGatewayUpdateError);
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const mountedAt = Date.now();
    let lastStatusCheckAt = 0;
    // A regular restart can recover before this effect mounts. Treat the
    // persisted restart flag itself as evidence so the first healthy probe
    // clears a stale blocker. Versioned updates still wait for their target.
    let restartObserved = !updatingActive && !targetVersion;
    let targetProbeActive = false;
    let targetProbeStartedAt = 0;
    let navigating = false;

    const completeSameOriginRestart = (version: string | null, reason: string) => {
      if (navigating) return;
      navigating = true;
      const reload = publishGatewayReload(version, reason);
      if (updatingActive) clearGatewayUpdating();
      else clearGatewayRestarting();
      reloadGatewayClient(reload.id);
    };

    // Gateway runs, but not the target version: the update was rolled back,
    // failed, or never happened. Leave the screen instead of waiting forever.
    const leaveUnfinishedUpdate = (runningVersion: string | null) => {
      if (navigating || !targetVersion) return;
      navigating = true;
      useUpdateStore.getState().clearUpdating();
      setGatewayUpdateError(
        `${
          runningVersion
            ? `Gateway ${runningVersion} is running instead of ${targetVersion}.`
            : `Gateway is running a version other than ${targetVersion}.`
        } The update did not complete; check the update container logs on the Gateway host.`,
        targetVersion,
        { rolledBack: true }
      );
    };

    const checkUpdateOutcome = async (runningVersion: string | null) => {
      const now = Date.now();
      const waited = now - (useAppStatusStore.getState().gatewayUpdatingStartedAt ?? mountedAt);
      if (waited >= GATEWAY_UPDATE_MAX_WAIT_MS) {
        leaveUnfinishedUpdate(runningVersion);
        return;
      }
      if (now - lastStatusCheckAt < GATEWAY_UPDATE_STATUS_CHECK_INTERVAL_MS) return;
      lastStatusCheckAt = now;
      const status = await useUpdateStore.getState().fetchStatus();
      if (!status || cancelled || navigating) return;
      // A waiting or running update keeps the screen; a failed one already
      // replaced it with its error (see the update store).
      if (status.gatewayOperation) return;
      // The server knows no update: the process that accepted it is gone.
      if (restartObserved || waited >= GATEWAY_UPDATE_UNKNOWN_GRACE_MS) {
        leaveUnfinishedUpdate(runningVersion);
      }
    };

    const navigateToRestartTarget = () => {
      if (navigating || !restartTargetUrl) return;
      navigating = true;
      clearGatewayRestarting();
      window.location.assign(buildGatewayRestartTargetUrl(restartTargetUrl, window.location.href));
    };

    const probeRestartTarget = async () => {
      if (!restartTargetUrl) return;
      const target = new URL(restartTargetUrl, window.location.href);
      const isHttpsDowngrade = window.location.protocol === "https:" && target.protocol === "http:";

      if (isHttpsDowngrade) {
        if (Date.now() - targetProbeStartedAt >= 2500) navigateToRestartTarget();
        return;
      }

      try {
        await fetch(new URL("/health", target).toString(), {
          cache: "no-store",
          credentials: "omit",
          mode: "no-cors",
        });
        navigateToRestartTarget();
      } catch {
        // Keep the current screen rendered until the new listener is reachable.
      }
    };

    const checkHealth = async () => {
      if (targetProbeActive) {
        await probeRestartTarget();
        return;
      }

      try {
        const response = await fetch("/health", {
          cache: "no-store",
          headers: { "X-Gateway-Health-Probe": "operation" },
        });
        if (!response.ok) {
          restartObserved = true;
          return;
        }

        const health = (await response.json()) as GatewayHealthSnapshot;
        const lifecycleState = health.lifecycleState ?? "running";
        if (lifecycleState !== "running") {
          restartObserved = true;
          return;
        }

        if (targetVersion) {
          if (isGatewayUpdateTargetVersion(health.version, targetVersion)) {
            completeSameOriginRestart(health.version ?? null, "gateway-update-target-ready");
            return;
          }
          if (updatingActive) await checkUpdateOutcome(health.version ?? null);
          return;
        }

        if (restartObserved) {
          if (restartTargetUrl) navigateToRestartTarget();
          else if (updatingActive || targetVersion) {
            completeSameOriginRestart(health.version ?? null, "gateway-restart-recovered");
          } else {
            // A regular Gateway restart has no new client assets to load.
            // Keep the current document alive so the event stream and active
            // route can recover without repeating the full startup prewarm.
            clearGatewayRestarting();
          }
        }
      } catch {
        restartObserved = true;
        if (restartTargetUrl) {
          targetProbeActive = true;
          targetProbeStartedAt = Date.now();
        }
      }
    };

    const runCheck = async () => {
      await checkHealth();
      if (!cancelled && !navigating) {
        timer = window.setTimeout(() => void runCheck(), 3000);
      }
    };

    void runCheck();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [
    clearGatewayRestarting,
    clearGatewayUpdating,
    restartTargetUrl,
    setGatewayUpdateError,
    targetVersion,
    updatingActive,
  ]);

  // The server reports whether the accepted update still waits for operations.
  useEffect(() => {
    if (updatingActive) void useUpdateStore.getState().fetchStatus();
  }, [updatingActive]);

  if (updatingActive && gatewayOperation?.status === "waiting_for_operations") {
    return <GatewayUpdateWaitingScreen operation={gatewayOperation} />;
  }

  return (
    <UpdateOperationScreen
      title={updatingActive ? "Updating Gateway" : "Restarting Gateway"}
      description={
        updatingActive && targetVersion
          ? `Gateway is updating to ${targetVersion}. New actions are temporarily locked.`
          : "Gateway is finishing active work before restarting. New actions are temporarily locked."
      }
    />
  );
}

function RelayOperationScreen() {
  const status = useUpdateStore((state) => state.status);
  const optimisticTargetVersion = useUpdateStore((state) => state.updatingTargetVersion);
  const abandonRelayUpdate = useUpdateStore((state) => state.abandonRelayUpdate);
  const canUpdate = useAuthStore((state) => state.hasScope("admin:update"));
  const [confirming, setConfirming] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetVersion =
    status?.relay.operation?.targetVersion ??
    optimisticTargetVersion ??
    status?.relay.latestVersion ??
    "the latest version";

  const handleAbandon = async () => {
    setAbandoning(true);
    setError(null);
    try {
      await abandonRelayUpdate();
    } catch (abandonError) {
      setError(
        abandonError instanceof Error ? abandonError.message : "The update could not be abandoned"
      );
      setAbandoning(false);
    }
  };

  return (
    <UpdateOperationScreen
      title="Updating Relay"
      description={`Relay is updating to ${targetVersion}. Active Secure Links may be briefly interrupted.`}
    >
      {canUpdate && (
        <div className="mt-5 space-y-2">
          {confirming ? (
            <>
              <p className="text-xs leading-[1.5] text-[#a1a1aa]">
                Abandon this update? Relays it drained return to service. Relays that already
                updated keep the new version.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  className="flex-1"
                  onClick={() => setConfirming(false)}
                  disabled={abandoning}
                >
                  Keep waiting
                </Button>
                <Button
                  variant="destructive"
                  className="flex-1"
                  onClick={handleAbandon}
                  disabled={abandoning}
                >
                  {abandoning && <Loader2 className="animate-spin" />}
                  Abandon update
                </Button>
              </div>
            </>
          ) : (
            <Button variant="secondary" className="w-full" onClick={() => setConfirming(true)}>
              Abandon update
            </Button>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
      )}
    </UpdateOperationScreen>
  );
}

function GatewayReloadCoordinator() {
  const gatewayUpdatingActive = useAppStatusStore((s) => s.gatewayUpdatingActive);
  const gatewayRestartingActive = useAppStatusStore((s) => s.gatewayRestartingActive);
  const maintenanceActive = useAppStatusStore((s) => s.maintenanceActive);
  const rateLimitedUntil = useAppStatusStore((s) => s.rateLimitedUntil);

  useEffect(() => {
    if (rateLimitedUntil != null) return;
    return subscribeGatewayReload((message) => reloadGatewayClient(message.id));
  }, [rateLimitedUntil]);

  useEffect(() => {
    if (
      maintenanceActive ||
      gatewayUpdatingActive ||
      gatewayRestartingActive ||
      rateLimitedUntil != null
    )
      return;

    let cancelled = false;
    let checking = false;
    let navigating = false;
    let baselineVersion: string | null = null;

    const checkVersion = async () => {
      if (checking || navigating || document.visibilityState !== "visible") return;
      checking = true;
      try {
        const currentVersion = await fetchGatewayCurrentVersion();
        if (!currentVersion || cancelled) return;

        if (baselineVersion == null) {
          baselineVersion = currentVersion;
          return;
        }

        if (
          normalizeGatewayUpdateVersion(currentVersion) !==
          normalizeGatewayUpdateVersion(baselineVersion)
        ) {
          navigating = true;
          const reload = publishGatewayReload(currentVersion, "gateway-version-changed");
          reloadGatewayClient(reload.id);
        }
      } catch {
        // Ignore transient backend downtime; explicit update mode has its own faster polling.
      } finally {
        checking = false;
      }
    };

    void checkVersion();
    const interval = window.setInterval(() => {
      void checkVersion();
    }, VERSION_RELOAD_CHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [gatewayRestartingActive, gatewayUpdatingActive, maintenanceActive, rateLimitedUntil]);

  return null;
}

function GatewayUpdateErrorScreen() {
  const error = useAppStatusStore((s) => s.gatewayUpdateError);
  const clearGatewayUpdateError = useAppStatusStore((s) => s.clearGatewayUpdateError);
  const canUpdate = useAuthStore((state) => state.hasScope("admin:update"));

  if (!error) return null;

  const handleReturn = () => {
    // Other admin sessions no longer need to be told about this attempt.
    if (error.rolledBack && canUpdate) {
      void Promise.resolve()
        .then(() => api.acknowledgeUpdateFailure())
        .catch(() => undefined);
    }
    clearGatewayUpdateError();
  };

  return (
    <div className="fixed inset-0 z-[205] flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-8 text-center">
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center border border-destructive/30 bg-destructive/5 text-destructive">
            <XCircle className="h-6 w-6" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">Update Failed</h2>
          <p className="text-sm text-muted-foreground">
            {error.rolledBack
              ? `Gateway could not complete the update${
                  error.targetVersion ? ` to ${error.targetVersion}` : ""
                }. The previous version is running.`
              : error.targetVersion
                ? `Gateway could not start the update to ${error.targetVersion}.`
                : "Gateway could not start the update."}
          </p>
          <p className="border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error.message}
          </p>
        </div>

        <div className="space-y-3">
          <Button onClick={handleReturn} className="w-full">
            Return to Gateway
          </Button>
          <p className="text-xs text-muted-foreground">
            {error.rolledBack
              ? "Review the update logs on the Gateway host before you retry the update."
              : "No restart was started. You can retry the update after resolving the error."}
          </p>
        </div>
      </div>
    </div>
  );
}

function RateLimitScreen() {
  const rateLimitedUntil = useAppStatusStore((s) => s.rateLimitedUntil);
  const clearRateLimit = useAppStatusStore((s) => s.clearRateLimit);
  const [secondsRemaining, setSecondsRemaining] = useState(0);

  useEffect(() => {
    if (!rateLimitedUntil) {
      setSecondsRemaining(0);
      return;
    }

    const updateRemaining = () => {
      const remaining = Math.max(0, Math.ceil((rateLimitedUntil - Date.now()) / 1000));
      setSecondsRemaining(remaining);
      if (remaining <= 0) {
        clearRateLimit();
      }
    };

    updateRemaining();
    const interval = window.setInterval(updateRemaining, 250);
    return () => window.clearInterval(interval);
  }, [clearRateLimit, rateLimitedUntil]);

  if (rateLimitedUntil == null) return null;

  return (
    <div className="fixed inset-0 z-[210] flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-8 text-center">
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center border border-warning/30 bg-warning/5 text-warning-foreground">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">Rate Limit Reached</h2>
          <p className="text-sm text-muted-foreground">
            You have been rate-limited. Requests will resume automatically in{" "}
            <span className="font-semibold text-foreground">{secondsRemaining}</span> second
            {secondsRemaining === 1 ? "" : "s"}.
          </p>
        </div>
      </div>
    </div>
  );
}

export function AppStatusGate() {
  const maintenanceActive = useAppStatusStore((s) => s.maintenanceActive);
  const gatewayUpdatingActive = useAppStatusStore((s) => s.gatewayUpdatingActive);
  const gatewayRestartingActive = useAppStatusStore((s) => s.gatewayRestartingActive);
  const gatewayUpdateError = useAppStatusStore((s) => s.gatewayUpdateError);
  const rateLimitedUntil = useAppStatusStore((s) => s.rateLimitedUntil);
  const relayUpdatingActive = useUpdateStore(
    (state) =>
      (state.isUpdating && state.updatingComponent === "relay") ||
      state.status?.relay.operation?.status === "updating"
  );
  const [showMaintenanceScreen, setShowMaintenanceScreen] = useState(false);

  useEffect(() => {
    if (!maintenanceActive) {
      setShowMaintenanceScreen(false);
      return;
    }

    const timeout = window.setTimeout(() => {
      setShowMaintenanceScreen(true);
    }, 800);

    return () => window.clearTimeout(timeout);
  }, [maintenanceActive]);

  return (
    <>
      <GatewayReloadCoordinator />
      {rateLimitedUntil != null ? (
        <RateLimitScreen />
      ) : gatewayUpdateError ? (
        <GatewayUpdateErrorScreen />
      ) : gatewayUpdatingActive || gatewayRestartingActive ? (
        <GatewayOperationScreen />
      ) : relayUpdatingActive ? (
        <RelayOperationScreen />
      ) : showMaintenanceScreen ? (
        <MaintenanceScreen />
      ) : null}
    </>
  );
}
