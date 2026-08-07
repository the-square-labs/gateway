import type { AIProviderStatus } from "./ai";
import type { Node } from "./nodes";
import type { SystemConfig, UpdateStatus } from "./system";

export type ReadModelAvailability = "available" | "unavailable" | "unknown";
export type ReadModelRefreshStatus = "never" | "refreshing" | "success" | "error";

export interface ReadModelSnapshot<T> {
  data: T;
  revision: number;
  observedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  refreshStatus: ReadModelRefreshStatus;
  availability: ReadModelAvailability;
}

export interface UIBootstrapShell {
  access: {
    fingerprint: string;
    scopes: string[];
  };
  systemConfig: SystemConfig;
  navigation: {
    hasNginxNodes: boolean;
    hasCloudflareIntegration: boolean;
    statusPageEnabled: boolean;
    dockerNodes: Node[];
    nodes: ReadModelSnapshot<Node[]>;
  };
  update: UpdateStatus | null;
  aiStatus: AIProviderStatus | null;
}
