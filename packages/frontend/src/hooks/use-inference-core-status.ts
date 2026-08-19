import { useCallback, useEffect, useState } from "react";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { eventStream } from "@/services/event-stream";
import type { InferenceCoreStatus } from "@/types/inference-core";

export const INFERENCE_CORE_CHANGED_CHANNEL = "inference.core.changed";

/** Poll cadence while the backend reports a running operation. */
const ACTIVE_OPERATION_POLL_MS = 2_500;

/**
 * Guard against out-of-order realtime events: a status snapshot carrying an
 * older operation (or an older revision of the same operation) must never
 * overwrite the newer operation the UI already shows.
 */
export function isStaleInferenceCoreStatus(
  current: InferenceCoreStatus | null,
  incoming: InferenceCoreStatus
): boolean {
  const currentOperation = current?.operation;
  const incomingOperation = incoming.operation;
  if (!currentOperation || !incomingOperation) return false;
  if (incomingOperation.id !== currentOperation.id) {
    return (
      new Date(incomingOperation.startedAt).getTime() <=
      new Date(currentOperation.startedAt).getTime()
    );
  }
  return (
    new Date(incomingOperation.updatedAt).getTime() < new Date(currentOperation.updatedAt).getTime()
  );
}

/**
 * Shared lifecycle status for the managed inference core. The server owns all
 * state: the hook bootstraps from GET /api/inference/core/status (so a reload
 * or navigation resumes the in-flight operation), applies realtime
 * `inference.core.changed` events, and polls while an operation is running.
 */
export function useInferenceCoreStatus(enabled = true) {
  const [status, setStatus] = useState<InferenceCoreStatus | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
    if (showLoading) setLoading(true);
    try {
      const next = await api.getInferenceCoreStatus();
      setStatus(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load the inference core status");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh({ showLoading: true });
  }, [enabled, refresh]);

  useRealtime(enabled ? INFERENCE_CORE_CHANGED_CHANNEL : null, (payload) => {
    const incoming = payload as InferenceCoreStatus;
    if (!incoming || typeof incoming !== "object" || typeof incoming.state !== "string") return;
    setStatus((current) => (isStaleInferenceCoreStatus(current, incoming) ? current : incoming));
    setError(null);
  });

  // A dropped connection can miss events; resync from the server on reconnect.
  useEffect(() => {
    if (!enabled) return;
    return eventStream.onReconnect(() => {
      void refresh();
    });
  }, [enabled, refresh]);

  const operationRunning = status?.operation?.status === "running";
  useEffect(() => {
    if (!enabled || !operationRunning) return;
    const timer = setInterval(() => void refresh(), ACTIVE_OPERATION_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, operationRunning, refresh]);

  return { status, loading, error, refresh };
}
