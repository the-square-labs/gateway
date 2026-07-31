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

async function fetchGatewayCurrentVersion(): Promise<string | null> {
  try {
    const response = await fetch("/api/system/version", {
      cache: "no-store",
      credentials: "include",
    });
    if (response.ok) {
      const payload = (await response.json()) as { data?: { currentVersion?: string } };
      return payload.data?.currentVersion ?? null;
    }
  } catch {
    // Fall through to the public health endpoint.
  }

  const response = await fetch("/health", { cache: "no-store" });
  const payload = (await response.json()) as { version?: string };
  return payload.version ?? null;
}

function MaintenanceScreen() {
  const setMaintenanceActive = useAppStatusStore((s) => s.setMaintenanceActive);

  useEffect(() => {
    const checkHealth = async () => {
      try {
        const response = await fetch("/health", { cache: "no-store" });
        if (response.ok) {
          setMaintenanceActive(false);
        }
      } catch {
        // Keep the maintenance screen visible until the backend answers again.
      }
    };

    void checkHealth();
    const interval = window.setInterval(() => {
      void checkHealth();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [setMaintenanceActive]);

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
          <p className="text-xs text-muted-foreground">Automatic retry is active.</p>
        </div>
      </div>
    </div>
  );
}

function GatewayUpdatingScreen() {
  const targetVersion = useAppStatusStore((s) => s.gatewayUpdatingTargetVersion);
  const clearGatewayUpdating = useAppStatusStore((s) => s.clearGatewayUpdating);

  useEffect(() => {
    let seenUnavailable = false;

    const checkHealth = async () => {
      try {
        const response = await fetch("/health", { cache: "no-store" });
        if (!response.ok) {
          seenUnavailable = true;
          return;
        }

        if (targetVersion) {
          const currentVersion = await fetchGatewayCurrentVersion();
          if (isGatewayUpdateTargetVersion(currentVersion, targetVersion)) {
            publishGatewayReload(currentVersion, "gateway-update-target-ready");
            clearGatewayUpdating();
            reloadGatewayClient();
            return;
          }
        }

        if (seenUnavailable) {
          publishGatewayReload(null, "gateway-update-recovered");
          clearGatewayUpdating();
          reloadGatewayClient();
        }
      } catch {
        seenUnavailable = true;
      }
    };

    const interval = window.setInterval(() => {
      void checkHealth();
    }, 3000);
    void checkHealth();

    return () => window.clearInterval(interval);
  }, [clearGatewayUpdating, targetVersion]);

  return (
    <div className="fixed inset-0 z-[205] flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-8 text-center">
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center border border-warning/30 bg-warning/5 text-warning-foreground">
            <RotateCw className="h-6 w-6 animate-spin" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">Updating Gateway</h2>
          <p className="text-sm text-muted-foreground">
            {targetVersion
              ? `Gateway is updating to ${targetVersion}.`
              : "Gateway is applying an update."}{" "}
            All actions are temporarily locked until the restart completes.
          </p>
        </div>

        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">This page will reload automatically.</p>
        </div>
      </div>
    </div>
  );
}

function GatewayReloadCoordinator() {
  const gatewayUpdatingActive = useAppStatusStore((s) => s.gatewayUpdatingActive);
  const rateLimitedUntil = useAppStatusStore((s) => s.rateLimitedUntil);

  useEffect(() => {
    if (rateLimitedUntil != null) return;
    return subscribeGatewayReload(() => reloadGatewayClient());
  }, [rateLimitedUntil]);

  useEffect(() => {
    if (gatewayUpdatingActive || rateLimitedUntil != null) return;

    let cancelled = false;
    let baselineVersion: string | null = null;

    const checkVersion = async () => {
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
          publishGatewayReload(currentVersion, "gateway-version-changed");
          reloadGatewayClient();
        }
      } catch {
        // Ignore transient backend downtime; explicit update mode has its own faster polling.
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
  }, [gatewayUpdatingActive, rateLimitedUntil]);

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
        window.location.reload();
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
            You have been rate-limited. The page will reload automatically in{" "}
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
      ) : gatewayUpdatingActive ? (
        <GatewayUpdatingScreen />
      ) : showMaintenanceScreen ? (
        <MaintenanceScreen />
      ) : null}
    </>
  );
}
