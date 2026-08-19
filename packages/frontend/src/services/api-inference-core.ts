import type {
  InferenceCoreLatest,
  InferenceCoreOperation,
  InferenceCoreStatus,
} from "@/types/inference-core";
import type { ApiClientBaseConstructor } from "./api-mixins";

export function withInferenceCoreApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class InferenceCoreApi extends Base {
    getInferenceCoreStatus(): Promise<InferenceCoreStatus> {
      return this.request("/inference/core/status");
    }

    installInferenceCore(version?: string): Promise<{ operation: InferenceCoreOperation }> {
      return this.request("/inference/core/install", {
        method: "POST",
        body: JSON.stringify(version ? { version } : {}),
      });
    }

    updateInferenceCore(version: string): Promise<{ operation: InferenceCoreOperation }> {
      return this.request("/inference/core/update", {
        method: "POST",
        body: JSON.stringify({ version }),
      });
    }

    repairInferenceCore(): Promise<{ operation: InferenceCoreOperation }> {
      return this.request("/inference/core/repair", { method: "POST" });
    }

    checkInferenceCoreUpdates(): Promise<{ latest: InferenceCoreLatest | null }> {
      return this.request("/inference/core/check-updates", { method: "POST" });
    }
  };
}
