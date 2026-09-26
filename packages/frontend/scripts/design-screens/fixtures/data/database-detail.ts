import { databaseHandlers, databaseTabHandlers, managedNodeHandlers } from "./database-handlers";
import { ordersLogLines } from "./database-tabs";
import { ordersDb, ordersMonitoringHistory } from "./databases";
import { installFixtureEventSource } from "./event-source";
import { storageHandlers } from "./storage-handlers";
import { installFixtureWebSocket } from "./websocket";

/** Every endpoint an orders-db tab reads: detail, tab content, backup destinations and hosts. */
export function ordersDetailHandlers() {
  return [
    ...databaseTabHandlers(),
    ...managedNodeHandlers(),
    ...databaseHandlers(),
    ...storageHandlers(),
  ];
}

/**
 * The monitoring stream opens with the saved health and metric history, and the
 * container log socket sends its initial tail, the way the server's first frames would.
 */
export function installOrdersStreams() {
  installFixtureEventSource((url) =>
    url.includes(`/databases/${ordersDb.id}/monitoring/stream`)
      ? {
          connected: { healthHistory: ordersDb.healthHistory, healthStatus: "online" },
          history: { history: ordersMonitoringHistory() },
        }
      : undefined
  );
  installFixtureWebSocket((url) =>
    url.includes(`/databases/${ordersDb.id}/logs/stream`)
      ? [{ type: "connected" }, { type: "initial", lines: ordersLogLines(), hasMore: true }]
      : undefined
  );
}
