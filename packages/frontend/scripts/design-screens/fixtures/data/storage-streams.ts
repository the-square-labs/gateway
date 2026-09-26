import { installFixtureEventSource } from "./event-source";
import { backupsStorage } from "./storage";
import { backupsHealthHistory, backupsMonitoringHistory } from "./storage-detail";

/** The storage monitoring stream opens with the saved health and metric history. */
export function installBackupsStreams() {
  installFixtureEventSource((url) =>
    url.includes(`/object-storage/${backupsStorage.id}/monitoring/stream`)
      ? {
          connected: { healthHistory: backupsHealthHistory, healthStatus: "online" },
          history: { history: backupsMonitoringHistory() },
        }
      : undefined
  );
}
