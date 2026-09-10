import type {
  HostingAccountSummary,
  HostingActionInput,
  HostingCapability,
  HostingCatalog,
  HostingConnector,
  HostingConnectorInput,
  HostingDiscovery,
  HostingFirewallUpdate,
  HostingFirewallView,
  HostingNodeBinding,
  HostingNodeProjection,
  HostingOperation,
  HostingProvisionInput,
  HostingResource,
  HostingSnapshotInput,
  HostingSnapshotsView,
} from "@/types/hosting";
import type { ApiClientBaseConstructor } from "./api-mixins";

export function withHostingApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class HostingApi extends Base {
    getHostingSnapshotFolders(id: string) {
      return this.request<import("@/types").ResourceFolderTreeNode[]>(
        `/hosting/resources/${encodeURIComponent(id)}/snapshot-folders`
      );
    }
    hostingSnapshotFolderAction<T = void>(
      id: string,
      operation: string,
      input: unknown,
      folderId?: string
    ) {
      return this.request<T>(
        `/hosting/resources/${encodeURIComponent(id)}/snapshot-folders/actions`,
        { method: "POST", body: JSON.stringify({ operation, input, folderId }) }
      );
    }
    getHostingSnapshots(id: string) {
      return this.request<HostingSnapshotsView>(
        `/hosting/resources/${encodeURIComponent(id)}/snapshots`
      );
    }
    hostingSnapshotAction(id: string, input: HostingSnapshotInput) {
      return this.request<HostingOperation>(
        `/hosting/resources/${encodeURIComponent(id)}/snapshots/actions`,
        { method: "POST", body: JSON.stringify(input) }
      );
    }
    listHostingConnectors() {
      return this.request<HostingConnector[]>("/integrations/hosting");
    }
    getHostingConnector(id: string) {
      return this.request<HostingConnector>(`/integrations/hosting/${encodeURIComponent(id)}`);
    }
    getHostingConfiguration(id: string) {
      return this.request<HostingConnector>(
        `/integrations/hosting/${encodeURIComponent(id)}/configuration`
      );
    }
    createHostingConnector(input: HostingConnectorInput) {
      return this.request<HostingConnector>("/integrations/hosting", {
        method: "POST",
        body: JSON.stringify(input),
      });
    }
    updateHostingConnector(id: string, input: HostingConnectorInput) {
      return this.request<HostingConnector>(`/integrations/hosting/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(input),
      });
    }
    previewHostingConnector(input: HostingConnectorInput) {
      return this.request<{
        name: string;
        capabilities: Record<string, HostingCapability>;
      }>("/integrations/hosting/test", { method: "POST", body: JSON.stringify(input) });
    }
    discoverHostingConnector(
      input: HostingConnectorInput & { connectorId?: string; tlsMode?: "system" | "ca" | "pin" }
    ) {
      return this.request<HostingDiscovery>("/integrations/hosting/discover", {
        method: "POST",
        body: JSON.stringify(input),
      });
    }
    testHostingConnector(id: string) {
      return this.request<{ success: boolean; capabilities?: Record<string, HostingCapability> }>(
        `/integrations/hosting/${encodeURIComponent(id)}/test`,
        { method: "POST" }
      );
    }
    syncHostingConnector(id: string) {
      return this.request<{ resourceCount?: number; skipped?: boolean }>(
        `/integrations/hosting/${encodeURIComponent(id)}/sync`,
        { method: "POST" }
      );
    }
    deleteHostingConnector(id: string) {
      return this.request<{ success: boolean }>(`/integrations/hosting/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    }
    getHostingCatalog(id: string) {
      return this.request<HostingCatalog>(
        `/integrations/hosting/${encodeURIComponent(id)}/catalog`
      );
    }
    getHostingAdoptionCandidates(id: string) {
      return this.request<import("@/types/hosting").HostingAdoptionCandidates>(
        `/integrations/hosting/${encodeURIComponent(id)}/adoption-candidates`
      );
    }
    adoptHostingNode(id: string, input: { resourceId: string; nodeId: string }) {
      return this.request<{ resourceId: string; nodeIds: string[] }>(
        `/integrations/hosting/${encodeURIComponent(id)}/adopt`,
        { method: "POST", body: JSON.stringify(input) }
      );
    }
    listHostingResources(id: string) {
      return this.request<HostingResource[]>(
        `/integrations/hosting/${encodeURIComponent(id)}/resources`
      );
    }
    listHostingOperations(id: string) {
      return this.request<HostingOperation[]>(
        `/integrations/hosting/${encodeURIComponent(id)}/operations`
      );
    }
    getHostingAccountSummary(id: string) {
      return this.request<HostingAccountSummary | null>(
        `/integrations/hosting/${encodeURIComponent(id)}/account-summary`
      );
    }
    provisionHostingNode(input: HostingProvisionInput) {
      return this.request<HostingOperation>("/hosting/operations", {
        method: "POST",
        body: JSON.stringify(input),
      });
    }
    getHostingOperation(id: string) {
      return this.request<HostingOperation>(`/hosting/operations/${encodeURIComponent(id)}`);
    }
    reconcileHostingOperation(id: string) {
      return this.request<HostingOperation>(
        `/hosting/operations/${encodeURIComponent(id)}/reconcile`,
        { method: "POST" }
      );
    }
    retryHostingInstall(id: string, input: { idempotencyKey: string; sshConnectorId?: string }) {
      return this.request<HostingOperation>(
        `/hosting/operations/${encodeURIComponent(id)}/retry-install`,
        {
          method: "POST",
          body: JSON.stringify(input),
        }
      );
    }
    hostingResourceAction(id: string, input: HostingActionInput) {
      return this.request<HostingOperation>(
        `/hosting/resources/${encodeURIComponent(id)}/actions`,
        { method: "POST", body: JSON.stringify(input) }
      );
    }
    getNodeHosting(nodeId: string) {
      return this.request<HostingNodeProjection | null>(
        `/hosting/nodes/${encodeURIComponent(nodeId)}`
      );
    }
    getNodeFirewall(nodeId: string) {
      return this.request<HostingFirewallView>(
        `/hosting/nodes/${encodeURIComponent(nodeId)}/firewall`
      );
    }
    updateNodeFirewall(nodeId: string, input: HostingFirewallUpdate) {
      return this.request<HostingFirewallView>(
        `/hosting/nodes/${encodeURIComponent(nodeId)}/firewall`,
        { method: "PUT", body: JSON.stringify(input) }
      );
    }
    listNodeHostingBindings() {
      return this.request<Record<string, HostingNodeBinding>>("/hosting/node-bindings");
    }
  };
}
