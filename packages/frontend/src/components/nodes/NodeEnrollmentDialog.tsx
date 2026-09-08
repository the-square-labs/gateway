import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { CopyCodeBlock } from "@/components/common/CopyCodeBlock";
import { CopyValueField } from "@/components/common/CopyValueField";
import { HostingNodeWizard } from "@/components/nodes/HostingNodeWizard";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDeferredDialogState } from "@/hooks/use-deferred-dialog-state";
import { useRealtime } from "@/hooks/use-realtime";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { canCreateInFolder } from "@/lib/scope-utils";
import { STEP_ANIMATION } from "@/pages/notifications/template-editor";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { handleLicenseApiError } from "@/stores/license-paywall";
import { useResourceFolderStore } from "@/stores/resource-folders";
import type { Node, NodeType, ResourceFolderTreeNode } from "@/types";
import type { HostingOperation, HostingResource } from "@/types/hosting";

type EnrollmentTargets = {
  public?: { label: string; gateway: string | null };
  local?: { label: string; gateway: string };
};

export const NODE_ENROLLMENT_TYPES: Array<{
  value: NodeType;
  label: string;
  description: string;
}> = [
  {
    value: "nginx",
    label: "Ingress",
    description: "Terminates TLS and serves public domains and routes.",
  },
  {
    value: "docker",
    label: "Docker",
    description: "Runs and manages containers, Compose projects, images, networks, and volumes.",
  },
  {
    value: "builder",
    label: "Build Worker",
    description: "Builds Git revisions and scans artifacts on an isolated Docker worker.",
  },
  {
    value: "databases",
    label: "Databases",
    description: "Hosts managed PostgreSQL, Redis, and ClickHouse instances.",
  },
  {
    value: "monitoring",
    label: "Monitoring",
    description: "Collects host health and metrics without managing workloads.",
  },
  {
    value: "relay",
    label: "Relay",
    description: "Adds a physical host to the Secure Link Relay Pool.",
  },
];

const INSTALLER_BASE = "https://raw.githubusercontent.com/the-square-labs/gateway/main/scripts";
const INSTALLER_BY_TYPE: Partial<Record<NodeType, string>> = {
  nginx: "setup-node.sh",
  docker: "setup-docker-node.sh",
  builder: "setup-docker-node.sh",
  databases: "setup-database-node.sh",
  monitoring: "setup-monitoring-node.sh",
  relay: "setup-relay-node.sh",
};

type EnrollmentResult = {
  nodeId: string;
  displayName: string;
  type: NodeType;
  token: string;
  gatewayCertSha256: string;
  targets?: EnrollmentTargets;
  relayAddress?: string;
};

type HostingRequest = {
  connectorId?: string;
  existingResource?: HostingResource;
};

export function NodeEnrollmentDialog({
  open,
  onOpenChange,
  initialType = "nginx",
  lockType = false,
  initialMode = "external",
  lockMode = false,
  hosting,
  onNodeCreated,
  onNodeEnrolled,
  onHostingCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialType?: NodeType;
  lockType?: boolean;
  initialMode?: "external" | "hosting";
  lockMode?: boolean;
  hosting?: HostingRequest;
  onNodeCreated?: (node: Node) => void;
  onNodeEnrolled?: (nodeId: string) => void;
  onHostingCreated?: (operation: HostingOperation) => void;
}) {
  const user = useAuthStore((state) => state.user);
  const [mode, setMode] = useState<"external" | "hosting">(initialMode);
  const [type, setType] = useState<NodeType>(initialType);
  const [displayName, setDisplayName] = useState("");
  const [folderId, setFolderId] = useState("");
  const [relayAddress, setRelayAddress] = useState("");
  const [creating, setCreating] = useState(false);
  const {
    open: resultOpen,
    value: result,
    setValue: setResult,
    close: closeResult,
    onOpenChange: onResultOpenChange,
  } = useDeferredDialogState<EnrollmentResult>();
  const [targetId, setTargetId] = useState("public");
  const [transport, setTransport] = useState<"curl" | "wget">("curl");
  const completedNodeRef = useRef<string | null>(null);
  const retainedHosting = useRetainedDialogValue(hosting ?? null, open);
  const [hostingModeLocked, setHostingModeLocked] = useState(false);
  const nodeFolders = useResourceFolderStore((state) => state.foldersByType.node);
  const foldersLoading = useResourceFolderStore((state) => state.loadingByType.node);
  const fetchFolders = useResourceFolderStore((state) => state.fetchFolders);
  const folderOptions = useMemo(() => flattenFolders(nodeFolders), [nodeFolders]);
  const fixedHosting = Boolean(retainedHosting?.connectorId || retainedHosting?.existingResource);
  const effectiveMode = fixedHosting ? "hosting" : mode;

  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setType(initialType);
    setDisplayName("");
    setFolderId("");
    setRelayAddress("");
    void fetchFolders("node");
  }, [fetchFolders, initialMode, initialType, open]);

  useEffect(() => {
    if (!open) setHostingModeLocked(false);
  }, [open]);

  useEffect(() => {
    if (!result) completedNodeRef.current = null;
  }, [result]);

  const completeEnrollment = useCallback(
    (nodeId: string) => {
      if (!resultOpen || result?.nodeId !== nodeId || completedNodeRef.current === nodeId) return;
      completedNodeRef.current = nodeId;
      toast.success(`${result.displayName} enrolled`);
      closeResult();
      onNodeEnrolled?.(nodeId);
    },
    [closeResult, onNodeEnrolled, result, resultOpen]
  );

  const checkEnrollment = useCallback(async () => {
    if (!resultOpen || !result) return;
    try {
      const node = await api.getNode(result.nodeId);
      if (node.status === "online") completeEnrollment(node.id);
    } catch {
      // The realtime event or the next reconnect will retry the status check.
    }
  }, [completeEnrollment, result, resultOpen]);

  useEffect(() => {
    void checkEnrollment();
  }, [checkEnrollment]);

  useRealtime(
    resultOpen && result ? "node.changed" : null,
    (payload) => {
      if (!payload || typeof payload !== "object") return;
      const event = payload as { id?: unknown; status?: unknown };
      const nodeId = result?.nodeId;
      if (!nodeId || event.id !== nodeId) return;
      if (event.status === "online") completeEnrollment(nodeId);
      else void checkEnrollment();
    },
    { onReconnect: () => void checkEnrollment() }
  );

  const selectedType =
    NODE_ENROLLMENT_TYPES.find((candidate) => candidate.value === type) ??
    NODE_ENROLLMENT_TYPES[0]!;
  const canCreate =
    canCreateInFolder(user?.scopes ?? [], "nodes:create", folderId || null) &&
    displayName.trim().length > 0 &&
    (type !== "relay" || relayAddress.trim().length > 0);
  const modeLocked = creating || hostingModeLocked;

  const createNode = async () => {
    if (!canCreate) return;
    setCreating(true);
    try {
      const normalizedRelayAddress = relayAddress.trim();
      const response = await api.createNode({
        type,
        hostname: "pending",
        displayName: displayName.trim(),
        folderId: folderId || null,
        ...(type === "relay"
          ? { serviceAddresses: [normalizedRelayAddress], servicePort: 9443 }
          : {}),
      });
      setResult({
        nodeId: response.node.id,
        displayName: displayName.trim(),
        type,
        token: response.enrollmentToken,
        gatewayCertSha256: response.gatewayCertSha256,
        targets: response.gatewayEnrollmentTargets,
        relayAddress: type === "relay" ? normalizedRelayAddress : undefined,
      });
      completedNodeRef.current = null;
      setTargetId("public");
      setTransport("curl");
      onNodeCreated?.(response.node);
      onOpenChange(false);
    } catch (error) {
      if (!handleLicenseApiError(error, "Managed nodes")) {
        toast.error(error instanceof Error ? error.message : "Failed to create node");
      }
    } finally {
      setCreating(false);
    }
  };

  const fallbackGateway = `${window.location.hostname}:9443`;
  const targets = useMemo(
    () =>
      result
        ? [
            {
              id: "public",
              label: result.targets?.public?.label ?? "Public node",
              gateway: result.targets?.public?.gateway ?? fallbackGateway,
            },
            ...(result.targets?.local
              ? [
                  {
                    id: "local",
                    label: result.targets.local.label,
                    gateway: result.targets.local.gateway,
                  },
                ]
              : []),
          ]
        : [],
    [fallbackGateway, result]
  );
  const selectedTarget = targets.find((target) => target.id === targetId) ?? targets[0];

  const commandForTarget = (gateway: string) => {
    if (!result) return "";
    const installer = INSTALLER_BY_TYPE[result.type];
    if (!installer) return "";
    const fetcher =
      transport === "curl"
        ? `curl -sSL ${INSTALLER_BASE}/${installer}`
        : `wget -qO- ${INSTALLER_BASE}/${installer}`;
    const profileArgument = result.type === "builder" ? " \\\n  --mode builder" : "";
    const relayArgument =
      result.type === "relay" && result.relayAddress
        ? ` \\\n  --advertise-address ${result.relayAddress}`
        : "";
    return `${fetcher} | sudo bash -s -- \\
  --gateway ${gateway} \\
  --token ${result.token} \\
  --gateway-cert-sha256 ${result.gatewayCertSha256}${profileArgument}${relayArgument}`;
  };

  const setupDescription =
    result?.type === "relay"
      ? "Installs the Relay supervisor and enrolls this host into the Relay Pool."
      : result?.type === "docker"
        ? "Installs the Docker management daemon and enrolls with this Gateway."
        : result?.type === "builder"
          ? "Installs the isolated Docker builder profile and enrolls with this Gateway."
          : result?.type === "databases"
            ? "Verifies safe ext4 image storage, then installs the managed database daemon."
            : result?.type === "monitoring"
              ? "Installs the monitoring agent and enrolls with this Gateway."
              : "Installs Nginx and the ingress daemon, then enrolls with this Gateway.";

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <HostingNodeWizard
          open={open && effectiveMode === "hosting"}
          onClose={() => onOpenChange(false)}
          connectorId={retainedHosting?.connectorId}
          existingResource={retainedHosting?.existingResource}
          onCreated={onHostingCreated}
          onModeLockChange={setHostingModeLocked}
          render={({ body, footer }) => (
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Add Node</DialogTitle>
                <DialogDescription>
                  {effectiveMode === "external"
                    ? "Create a pending node and run its one-time setup command on the target host."
                    : retainedHosting?.existingResource
                      ? "Install Gateway on the selected provider VM."
                      : "Create and enroll a node using a connected hosting account. Nothing is ordered before your confirmation."}
                </DialogDescription>
              </DialogHeader>
              {!fixedHosting && !lockMode && (
                <Tabs value={mode} onValueChange={(value) => setMode(value as typeof mode)}>
                  <TabsList>
                    <TabsTrigger value="external" disabled={modeLocked}>
                      External
                    </TabsTrigger>
                    <TabsTrigger value="hosting" disabled={modeLocked}>
                      Hosting
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              )}
              <AnimatedHeight>
                <AnimatePresence initial={false} mode="wait">
                  <motion.div key={effectiveMode} {...STEP_ANIMATION}>
                    {effectiveMode === "external" ? (
                      <div className="space-y-4">
                        <div className="space-y-1.5">
                          <label className="text-sm font-medium">Node Type</label>
                          <Select
                            value={type}
                            onValueChange={(value) => setType(value as NodeType)}
                            disabled={lockType}
                          >
                            <SelectTrigger aria-label="Node Type">
                              <SelectValue>{selectedType.label}</SelectValue>
                            </SelectTrigger>
                            <SelectContent className="w-[min(28rem,calc(100vw-2rem))]">
                              {NODE_ENROLLMENT_TYPES.map((option) => (
                                <SelectItem
                                  key={option.value}
                                  value={option.value}
                                  textValue={option.label}
                                  description={option.description}
                                  className="items-start py-2"
                                >
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <p className="text-xs text-muted-foreground">
                            {selectedType.description}
                          </p>
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-sm font-medium">Folder</label>
                          <Select
                            value={
                              folderId ||
                              (canCreateInFolder(user?.scopes ?? [], "nodes:create", null)
                                ? "__none__"
                                : "")
                            }
                            onValueChange={(value) =>
                              setFolderId(value === "__none__" ? "" : value)
                            }
                            disabled={foldersLoading}
                          >
                            <SelectTrigger aria-label="Folder" aria-busy={foldersLoading}>
                              <SelectValue
                                placeholder={
                                  foldersLoading ? "Loading folders…" : "Select a folder"
                                }
                              />
                            </SelectTrigger>
                            <SelectContent>
                              {canCreateInFolder(user?.scopes ?? [], "nodes:create", null) && (
                                <SelectItem value="__none__">No folder</SelectItem>
                              )}
                              {folderOptions
                                .filter((folder) =>
                                  canCreateInFolder(user?.scopes ?? [], "nodes:create", folder.id)
                                )
                                .map((folder) => (
                                  <SelectItem key={folder.id} value={folder.id}>
                                    {"  ".repeat(folder.depth) + folder.name}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-sm font-medium">Node Name</label>
                          <Input
                            value={displayName}
                            onChange={(event) => setDisplayName(event.target.value)}
                            placeholder={type === "relay" ? "EU Relay" : "US-East Ingress"}
                          />
                        </div>
                        {type === "relay" && (
                          <div className="space-y-1.5">
                            <label className="text-sm font-medium">Relay Address</label>
                            <Input
                              value={relayAddress}
                              onChange={(event) => setRelayAddress(event.target.value)}
                              placeholder="relay.example.com"
                            />
                            <p className="text-xs text-muted-foreground">
                              Reachable IP or hostname advertised to participating nodes. TCP 9443
                              must be accessible.
                            </p>
                          </div>
                        )}
                      </div>
                    ) : (
                      body
                    )}
                  </motion.div>
                </AnimatePresence>
              </AnimatedHeight>
              <DialogFooter>
                {effectiveMode === "external" ? (
                  <>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                      Cancel
                    </Button>
                    <Button onClick={() => void createNode()} disabled={creating || !canCreate}>
                      {creating ? "Creating..." : "Create Node"}
                    </Button>
                  </>
                ) : (
                  footer
                )}
              </DialogFooter>
            </DialogContent>
          )}
        />
      </Dialog>

      <Dialog open={resultOpen} onOpenChange={onResultOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Node Created</DialogTitle>
            <DialogDescription>
              This dialog closes automatically when the node completes enrollment.
            </DialogDescription>
          </DialogHeader>
          {result && (
            <div className="space-y-4">
              <div className="border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
                <p className="font-medium">
                  The enrollment token is single-use and will not be shown again.
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Setup Command</label>
                <p className="text-xs text-muted-foreground">{setupDescription}</p>
                {targets.length > 1 && (
                  <p className="text-xs text-muted-foreground">
                    Use the public command for remote hosts and the local command for nodes on the
                    private network.
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {targets.length > 1 && (
                    <Tabs value={selectedTarget?.id ?? "public"} onValueChange={setTargetId}>
                      <TabsList>
                        {targets.map((target) => (
                          <TabsTrigger key={target.id} value={target.id}>
                            {target.label}
                          </TabsTrigger>
                        ))}
                      </TabsList>
                    </Tabs>
                  )}
                  <Tabs
                    value={transport}
                    onValueChange={(value) => setTransport(value as "curl" | "wget")}
                  >
                    <TabsList>
                      <TabsTrigger value="curl">curl</TabsTrigger>
                      <TabsTrigger value="wget">wget</TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>
                {selectedTarget && (
                  <CopyCodeBlock
                    label={`${transport} command`}
                    value={commandForTarget(selectedTarget.gateway)}
                    copyValue={commandForTarget(selectedTarget.gateway).replace(/\s*\\\n\s*/g, " ")}
                    className="[&>p]:hidden"
                  />
                )}
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Enrollment Token</label>
                <p className="text-xs text-muted-foreground">
                  For manual setup and troubleshooting only.
                </p>
                <CopyValueField label="Enrollment token" value={result.token} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => closeResult()}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function flattenFolders(folders: ResourceFolderTreeNode[]): ResourceFolderTreeNode[] {
  return folders.flatMap((folder) => [folder, ...flattenFolders(folder.children)]);
}
