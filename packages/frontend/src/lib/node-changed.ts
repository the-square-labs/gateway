/** One node.changed event as the backend publishes it. */
export interface NodeChangedEvent {
  id?: string;
  action?: string;
  status?: string;
  [key: string]: unknown;
}

/**
 * The events of one node inside a node.changed payload, oldest first. The event stream coalesces
 * bursts into one payload that carries every node's latest event in `changes`, so a view of one
 * node must look there instead of at the top-level fields, which describe only the last event.
 */
export function nodeChangesFor(payload: unknown, nodeId: string): NodeChangedEvent[] {
  if (!payload || typeof payload !== "object") return [];
  const changes = (payload as { changes?: unknown }).changes;
  const events = Array.isArray(changes) ? changes : [payload];
  return events.filter(
    (event): event is NodeChangedEvent =>
      !!event && typeof event === "object" && (event as NodeChangedEvent).id === nodeId
  );
}
