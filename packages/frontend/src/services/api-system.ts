import type {
  DaemonUpdateStatus,
  DashboardRelaySnapshot,
  HousekeepingConfig,
  HousekeepingRunResult,
  HousekeepingStats,
  LicenseStatusView,
  SystemConfig,
  UpdateStatus,
} from "@/types";
import type { ApiClientBaseConstructor } from "./api-mixins";

export function withSystemApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class SystemApiClient extends Base {
    async getVersionInfo(): Promise<UpdateStatus> {
      return this.unwrapData(this.request<{ data: UpdateStatus }>("/system/version"));
    }

    async getSystemConfig(): Promise<SystemConfig> {
      return this.unwrapData(this.request<{ data: SystemConfig }>("/system/config"));
    }

    async retryRelayRecovery(): Promise<DashboardRelaySnapshot> {
      return this.unwrapData(
        this.request<{ data: DashboardRelaySnapshot }>("/system/relay/recovery", { method: "POST" })
      );
    }

    async getRelayStatus(): Promise<DashboardRelaySnapshot | null> {
      return this.unwrapData(
        this.request<{ data: DashboardRelaySnapshot | null }>("/system/relay")
      );
    }

    async rebalanceRelayPool(): Promise<unknown> {
      return this.unwrapData(
        this.request<{ data: unknown }>("/system/relay/rebalance", { method: "POST" })
      );
    }

    async setRelayInstanceDrain(
      instanceId: string,
      enabled: boolean
    ): Promise<DashboardRelaySnapshot> {
      const action = enabled ? "drain" : "resume";
      return this.unwrapData(
        this.request<{ data: DashboardRelaySnapshot }>(
          `/system/relay/instances/${instanceId}/${action}`,
          {
            method: "POST",
            ...(enabled ? { body: JSON.stringify({ confirm: true }) } : {}),
          }
        )
      );
    }

    async forceDisconnectRelayInstance(instanceId: string): Promise<DashboardRelaySnapshot> {
      return this.unwrapData(
        this.request<{ data: DashboardRelaySnapshot }>(
          `/system/relay/instances/${instanceId}/force-disconnect`,
          { method: "POST", body: JSON.stringify({ confirm: true }) }
        )
      );
    }

    async checkForUpdates(): Promise<UpdateStatus> {
      return this.unwrapData(
        this.request<{ data: UpdateStatus }>("/system/check-update", { method: "POST" })
      );
    }

    async triggerUpdate(version: string): Promise<{ status: string; targetVersion: string }> {
      return this.unwrapData(
        this.request<{ data: { status: string; targetVersion: string } }>("/system/update", {
          method: "POST",
          body: JSON.stringify({ version }),
        })
      );
    }

    async triggerRelayUpdate(version: string): Promise<{ status: string; targetVersion: string }> {
      return this.unwrapData(
        this.request<{ data: { status: string; targetVersion: string } }>("/system/relay-update", {
          method: "POST",
          body: JSON.stringify({ version }),
        })
      );
    }

    async getReleaseNotes(version: string): Promise<string> {
      const result = await this.unwrapData(
        this.request<{ data: { version: string; notes: string } }>(
          `/system/release-notes/${encodeURIComponent(version)}`
        )
      );
      return result.notes;
    }

    async getAllReleaseNotes(): Promise<{ version: string; notes: string }[]> {
      return this.unwrapData(
        this.request<{ data: { version: string; notes: string }[] }>("/system/release-notes")
      );
    }

    // ── Daemon Updates ──────────────────────────────────────────────

    async getDaemonUpdates(): Promise<DaemonUpdateStatus[]> {
      return this.unwrapData(
        this.request<{ data: DaemonUpdateStatus[] }>("/system/daemon-updates")
      );
    }

    async checkDaemonUpdates(): Promise<DaemonUpdateStatus[]> {
      return this.unwrapData(
        this.request<{ data: DaemonUpdateStatus[] }>("/system/daemon-updates/check", {
          method: "POST",
        })
      );
    }

    async triggerDaemonUpdate(
      nodeId: string
    ): Promise<{ scheduled: boolean; targetVersion: string }> {
      return this.unwrapData(
        this.request<{ data: { scheduled: boolean; targetVersion: string } }>(
          `/system/daemon-updates/${nodeId}`,
          { method: "POST" }
        )
      );
    }

    // ── License ─────────────────────────────────────────────────────

    async getLicenseStatus(): Promise<LicenseStatusView> {
      return this.unwrapData(this.request<{ data: LicenseStatusView }>("/system/license/status"));
    }

    async activateLicense(licenseKey: string): Promise<LicenseStatusView> {
      return this.unwrapData(
        this.request<{ data: LicenseStatusView }>("/system/license/activate", {
          method: "POST",
          body: JSON.stringify({ licenseKey }),
        })
      );
    }

    async checkLicense(): Promise<LicenseStatusView> {
      return this.unwrapData(
        this.request<{ data: LicenseStatusView }>("/system/license/check", { method: "POST" })
      );
    }

    async clearLicenseKey(): Promise<LicenseStatusView> {
      return this.unwrapData(
        this.request<{ data: LicenseStatusView }>("/system/license/key", { method: "DELETE" })
      );
    }

    // ── Housekeeping ────────────────────────────────────────────────

    async getHousekeepingConfig(): Promise<HousekeepingConfig> {
      return this.unwrapData(this.request<{ data: HousekeepingConfig }>("/housekeeping/config"));
    }

    async updateHousekeepingConfig(
      config: Partial<HousekeepingConfig>
    ): Promise<HousekeepingConfig> {
      return this.unwrapData(
        this.request<{ data: HousekeepingConfig }>("/housekeeping/config", {
          method: "PUT",
          body: JSON.stringify(config),
        })
      );
    }

    async getHousekeepingStats(): Promise<HousekeepingStats> {
      return this.unwrapData(this.request<{ data: HousekeepingStats }>("/housekeeping/stats"));
    }

    async runHousekeeping(): Promise<HousekeepingRunResult> {
      return this.unwrapData(
        this.request<{ data: HousekeepingRunResult }>("/housekeeping/run", { method: "POST" })
      );
    }

    async getHousekeepingHistory(): Promise<HousekeepingRunResult[]> {
      return this.unwrapData(
        this.request<{ data: HousekeepingRunResult[] }>("/housekeeping/history")
      );
    }
  };
}
