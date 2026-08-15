import { AlertTriangle, RotateCw, ServerCrash, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  isGatewayUpdateTargetVersion,
  normalizeGatewayUpdateVersion,
  publishGatewayReload,
  reloadGatewayClient,
  subscribeGatewayReload,
} from "@/lib/gateway-update-reload";
import { useAppStatusStore } from "@/stores/app-status";

export { isGatewayUpdateTargetVersion, normalizeGatewayUpdateVersion };

const VERSION_RELOAD_CHECK_INTERVAL_MS = 30_000;
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
  const [backendReady, setBackendReady] = useState(false);

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
        const ready = healthResponse.ok && health?.lifecycleState === "running" && apiResponse.ok;

        consecutiveReadyChecks = ready ? consecutiveReadyChecks + 1 : 0;
        if (consecutiveReadyChecks >= 2) {
          const autoReloadAlreadyAttempted =
            window.sessionStorage.getItem(MAINTENANCE_AUTO_RELOAD_GUARD_KEY) === "1";
          if (!autoReloadAlreadyAttempted) {
            window.sessionStorage.setItem(MAINTENANCE_AUTO_RELOAD_GUARD_KEY, "1");
            window.location.reload();
          } else if (!cancelled) {
            setBackendReady(true);
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
  }, []);

  return (
    <div className="fixed inset-0 z-[200] flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-8 text-center">
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center border border-destructive/30 bg-destructive/5">
            <ServerCrash className="h-6 w-6" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">Temporarily Unavailable</h2>
          <p className="text-sm text-muted-foreground">
            The backend is not responding right now. Your session is preserved.
          </p>
        </div>

        <div className="space-y-3">
          <Button onClick={() => window.location.reload()} className="w-full">
            <RotateCw className="mr-2 h-4 w-4" />
            Reload now
          </Button>
          <p className="text-xs text-muted-foreground">
            {backendReady
              ? "The backend is available. Reload to continue."
              : "Checking backend availability automatically."}
          </p>
        </div>
      </div>
    </div>
  );
}

interface GatewayHealthSnapshot {
  lifecycleState?: "running" | "draining_user" | "draining_logs" | "terminating";
  version?: string | null;
}

export function buildGatewayRestartTargetUrl(targetBase: string, currentHref: string): string {
  const target = new URL(targetBase, currentHref);
  const current = new URL(currentHref);
  target.pathname = current.pathname;
  target.search = current.search;
  target.hash = current.hash;
  return target.toString();
}

function GatewayOperationScreen() {
  const updatingActive = useAppStatusStore((s) => s.gatewayUpdatingActive);
  const targetVersion = useAppStatusStore((s) => s.gatewayUpdatingTargetVersion);
  const restartTargetUrl = useAppStatusStore((s) => s.gatewayRestartTargetUrl);
  const clearGatewayUpdating = useAppStatusStore((s) => s.clearGatewayUpdating);
  const clearGatewayRestarting = useAppStatusStore((s) => s.clearGatewayRestarting);
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
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
    targetVersion,
    updatingActive,
  ]);

  return (
    <div className="fixed inset-0 z-[205] flex min-h-screen items-center justify-center bg-[#090909] px-6 text-[#f4f4f5]">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center border border-[rgba(234,179,8,0.35)] bg-[rgba(234,179,8,0.06)] text-[#facc15]">
          <RotateCw className="h-6 w-6 animate-spin motion-reduce:[animation-duration:1.8s]" />
        </div>
        <h2 className="m-0 text-lg font-semibold leading-[1.4]">
          {updatingActive ? "Updating Gateway" : "Restarting Gateway"}
        </h2>
        <p className="mt-2 text-sm leading-[1.55] text-[#a1a1aa]">
          {updatingActive && targetVersion
            ? `Gateway is updating to ${targetVersion}. New actions are temporarily locked.`
            : "Gateway is finishing active work before restarting. New actions are temporarily locked."}
        </p>
        <div className="mt-7 text-xs text-[#71717a]">
          Powered by{" "}
          <a
            href="https://wiolett.net"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#a1a1aa] hover:underline"
          >
            Wiolett Industries
          </a>
        </div>
      </div>
    </div>
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

  if (!error) return null;

  return (
    <div className="fixed inset-0 z-[205] flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-8 text-center">
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center border border-destructive/30 bg-destructive/5 text-destructive">
            <XCircle className="h-6 w-6" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">Update Failed</h2>
          <p className="text-sm text-muted-foreground">
            {error.targetVersion
              ? `Gateway could not start the update to ${error.targetVersion}.`
              : "Gateway could not start the update."}
          </p>
          <p className="border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error.message}
          </p>
        </div>

        <div className="space-y-3">
          <Button onClick={clearGatewayUpdateError} className="w-full">
            Return to Gateway
          </Button>
          <p className="text-xs text-muted-foreground">
            No restart was started. You can retry the update after resolving the error.
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
      ) : showMaintenanceScreen ? (
        <MaintenanceScreen />
      ) : null}
    </>
  );
}
