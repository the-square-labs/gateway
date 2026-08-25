import { GitBranch, Pencil, Play, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
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
import { Switch } from "@/components/ui/switch";
import { api } from "@/services/api";
import { handleLicenseApiError, requireLicenseFeature } from "@/stores/license-paywall";
import type { DockerBuildSecret, DockerSourceBinding, DockerSourceTarget } from "@/types";
import { RepositorySourceFields } from "../docker-deploy/RepositorySourceFields";
import { useDockerSourceRepositories } from "../docker-deploy/useDockerSourceRepositories";

interface DockerGitSourcePanelProps {
  target?: DockerSourceTarget;
  source?: DockerSourceBinding | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onBuildQueued?: () => void;
  composeVariables?: Record<string, string>;
  composeSecretKeys?: string[];
}

type VulnerabilityThreshold = "critical" | "high" | "medium" | "low" | "none";

function commitBadge(sha: string | null, empty: string) {
  return sha ? (
    <Badge variant="outline" className="max-w-full font-mono">
      {sha.slice(0, 12)}
    </Badge>
  ) : (
    <span className="text-sm text-muted-foreground">{empty}</span>
  );
}

export function DockerGitSourcePanel({
  target,
  source: suppliedSource,
  loading: suppliedLoading,
  error,
  onRetry,
  onBuildQueued,
  composeVariables = {},
  composeSecretKeys = [],
}: DockerGitSourcePanelProps) {
  const [source, setSource] = useState<DockerSourceBinding | null>(suppliedSource ?? null);
  const [loading, setLoading] = useState(suppliedSource === undefined);
  const [saving, setSaving] = useState(false);
  const [building, setBuilding] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [branch, setBranch] = useState(suppliedSource?.branch ?? "main");
  const [dockerfilePath, setDockerfilePath] = useState(
    suppliedSource?.dockerfilePath ?? "Dockerfile"
  );
  const [contextPath, setContextPath] = useState(suppliedSource?.contextPath ?? ".");
  const [composeFilePath, setComposeFilePath] = useState(
    suppliedSource?.composeFilePath ?? "compose.yaml"
  );
  const [autoBuild, setAutoBuild] = useState(suppliedSource?.autoBuild ?? true);
  const [autoDeploy, setAutoDeploy] = useState(suppliedSource?.autoDeploy ?? true);
  const [vulnerabilityThreshold, setVulnerabilityThreshold] = useState<VulnerabilityThreshold>(
    suppliedSource?.policy?.vulnerabilityThreshold ?? "critical"
  );
  const [buildSecrets, setBuildSecrets] = useState<DockerBuildSecret[]>(() =>
    (suppliedSource?.buildSecretNames ?? []).map((name, index) => ({
      id: `source-secret-${index}`,
      name,
      createdAt: suppliedSource?.createdAt ?? new Date(0).toISOString(),
      updatedAt: suppliedSource?.updatedAt ?? new Date(0).toISOString(),
    }))
  );
  const [secretDialogOpen, setSecretDialogOpen] = useState(false);
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [secretSaving, setSecretSaving] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectorId, setConnectorId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [connectBranch, setConnectBranch] = useState("main");
  const [connectDockerfilePath, setConnectDockerfilePath] = useState("Dockerfile");
  const [connectContextPath, setConnectContextPath] = useState(".");
  const [connectComposeFilePath, setConnectComposeFilePath] = useState("compose.yaml");
  const [connectAutoBuild, setConnectAutoBuild] = useState(true);
  const [connectAutoDeploy, setConnectAutoDeploy] = useState(true);
  const targetKind = target?.kind;
  const targetNodeId = target?.nodeId;
  const targetResourceId =
    target?.kind === "container"
      ? target.containerName
      : target?.kind === "deployment"
        ? target.deploymentId
        : target?.composeProjectId;
  const composeTarget = target?.kind === "compose_project";
  const { connectorOptions, repositories } = useDockerSourceRepositories(connectOpen, connectorId);
  const sourceId = source?.id;

  useEffect(() => {
    if (suppliedSource !== undefined) {
      setSource(suppliedSource);
    }
  }, [suppliedSource]);

  useEffect(() => {
    if (
      suppliedSource !== undefined ||
      !targetKind ||
      !targetResourceId ||
      ((targetKind === "container" || targetKind === "compose_project") && !targetNodeId)
    )
      return;
    const sourceTarget: DockerSourceTarget =
      targetKind === "container"
        ? { kind: "container", nodeId: targetNodeId!, containerName: targetResourceId }
        : targetKind === "deployment"
          ? { kind: "deployment", nodeId: targetNodeId, deploymentId: targetResourceId }
          : { kind: "compose_project", nodeId: targetNodeId!, composeProjectId: targetResourceId };
    setLoading(true);
    void api
      .getDockerSource(sourceTarget)
      .then(setSource)
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : "Failed to load repository source")
      )
      .finally(() => setLoading(false));
  }, [suppliedSource, targetKind, targetNodeId, targetResourceId]);

  useEffect(() => {
    if (
      !sourceId ||
      !targetKind ||
      !targetResourceId ||
      ((targetKind === "container" || targetKind === "compose_project") && !targetNodeId)
    )
      return;
    const sourceTarget: DockerSourceTarget =
      targetKind === "container"
        ? { kind: "container", nodeId: targetNodeId!, containerName: targetResourceId }
        : targetKind === "deployment"
          ? { kind: "deployment", nodeId: targetNodeId, deploymentId: targetResourceId }
          : { kind: "compose_project", nodeId: targetNodeId!, composeProjectId: targetResourceId };
    void api
      .listDockerBuildSecrets(sourceTarget)
      .then(setBuildSecrets)
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : "Failed to load Build Secrets")
      );
  }, [sourceId, targetKind, targetNodeId, targetResourceId]);

  useEffect(() => {
    if (!source) return;
    setBranch(source.branch);
    setDockerfilePath(source.dockerfilePath);
    setContextPath(source.contextPath);
    setComposeFilePath(source.composeFilePath ?? "compose.yaml");
    setAutoBuild(source.autoBuild);
    setAutoDeploy(source.autoDeploy);
    setVulnerabilityThreshold(source.policy?.vulnerabilityThreshold ?? "critical");
  }, [source]);

  const dirty = Boolean(
    source &&
      (branch !== source.branch ||
        (composeTarget
          ? composeFilePath !== (source.composeFilePath ?? "compose.yaml")
          : dockerfilePath !== source.dockerfilePath || contextPath !== source.contextPath) ||
        autoBuild !== source.autoBuild ||
        autoDeploy !== source.autoDeploy ||
        vulnerabilityThreshold !== (source.policy?.vulnerabilityThreshold ?? "critical"))
  );

  const save = async () => {
    if (
      !source ||
      !branch.trim() ||
      (composeTarget ? !composeFilePath.trim() : !dockerfilePath.trim() || !contextPath.trim())
    )
      return;
    setSaving(true);
    try {
      if (!target) return;
      setSource(
        await api.upsertDockerSource(target, {
          connectorId: source.connectorId,
          projectId: source.projectId,
          branch: branch.trim(),
          dockerfilePath: dockerfilePath.trim(),
          contextPath: contextPath.trim(),
          composeFilePath: composeTarget ? composeFilePath.trim() : undefined,
          composeVariables: source.composeVariables,
          composeSecretKeys: source.composeSecretKeys,
          autoBuild,
          autoDeploy,
          buildArgs: source.buildArgs,
          buildSecretNames: source.buildSecretNames,
          policy: {
            ...source.policy,
            vulnerabilityThreshold,
          },
        })
      );
      toast.success("Repository settings updated");
    } catch (error) {
      if (!handleLicenseApiError(error, "Git push-to-deploy")) {
        toast.error(
          error instanceof Error ? error.message : "Failed to update repository settings"
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const openConnect = () => {
    if (!requireLicenseFeature("git-push-to-deploy", "Git push-to-deploy")) return;
    setConnectOpen(true);
  };

  const connectSource = async () => {
    if (!target || !connectorId || !projectId || !connectBranch.trim()) return;
    if (composeTarget && !connectComposeFilePath.trim()) return;
    setConnecting(true);
    try {
      const connected = await api.upsertDockerSource(target, {
        connectorId,
        projectId,
        branch: connectBranch.trim(),
        dockerfilePath: connectDockerfilePath.trim() || "Dockerfile",
        contextPath: connectContextPath.trim() || ".",
        composeFilePath: composeTarget ? connectComposeFilePath.trim() : undefined,
        composeVariables: composeTarget ? composeVariables : undefined,
        composeSecretKeys: composeTarget ? composeSecretKeys : undefined,
        autoBuild: connectAutoBuild,
        autoDeploy: connectAutoDeploy,
        buildArgs: {},
        buildSecretNames: [],
        policy: { vulnerabilityThreshold: "critical" },
      });
      setSource(connected);
      setConnectOpen(false);
      toast.success("Repository connected");
    } catch (error) {
      if (!handleLicenseApiError(error, "Git push-to-deploy")) {
        toast.error(error instanceof Error ? error.message : "Failed to connect repository");
      }
    } finally {
      setConnecting(false);
    }
  };

  const saveBuildSecret = async () => {
    const name = secretName.trim();
    if (!name || !secretValue || !source) return;
    setSecretSaving(true);
    try {
      const saved = target ? await api.upsertDockerBuildSecret(target, name, secretValue) : null;
      if (!saved) return;
      setBuildSecrets((current) =>
        [...current.filter((secret) => secret.name !== saved.name), saved].sort((a, b) =>
          a.name.localeCompare(b.name)
        )
      );
      setSource((current) =>
        current
          ? {
              ...current,
              buildSecretNames: [
                ...current.buildSecretNames.filter((candidate) => candidate !== saved.name),
                saved.name,
              ].sort(),
            }
          : current
      );
      setSecretDialogOpen(false);
      setSecretName("");
      setSecretValue("");
      toast.success("Build Secret saved");
    } catch (error) {
      if (!handleLicenseApiError(error, "Git push-to-deploy")) {
        toast.error(error instanceof Error ? error.message : "Failed to save Build Secret");
      }
    } finally {
      setSecretSaving(false);
    }
  };

  const removeBuildSecret = async (name: string) => {
    const accepted = await confirm({
      title: "Delete Build Secret",
      description: `Delete ${name}? Builds that mount this secret will fail until it is added again.`,
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!accepted) return;
    try {
      if (target) await api.deleteDockerBuildSecret(target, name);
      setBuildSecrets((current) => current.filter((secret) => secret.name !== name));
      setSource((current) =>
        current
          ? {
              ...current,
              buildSecretNames: current.buildSecretNames.filter((candidate) => candidate !== name),
            }
          : current
      );
      toast.success("Build Secret removed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove Build Secret");
    }
  };

  const openBuildSecretDialog = (name = "") => {
    setSecretName(name);
    setSecretValue("");
    setSecretDialogOpen(true);
  };

  const triggerBuild = async () => {
    if (!source) return;
    if (!target) return;
    setBuilding(true);
    try {
      await api.createDockerSourceBuild(target, { force: true });
      toast.success("Build queued");
      onBuildQueued?.();
    } catch (error) {
      if (!handleLicenseApiError(error, "Git push-to-deploy")) {
        toast.error(error instanceof Error ? error.message : "Failed to queue build");
      }
    } finally {
      setBuilding(false);
    }
  };

  const disconnectSource = async () => {
    if (!target || !source) return;
    const accepted = await confirm({
      title: "Disconnect repository",
      description:
        "Stop repository polling, webhooks, builds, and automatic deployment for this resource? Existing runtime state and build history are preserved.",
      confirmLabel: "Disconnect",
      variant: "destructive",
    });
    if (!accepted) return;
    setDisconnecting(true);
    try {
      await api.removeDockerSource(target);
      setSource(null);
      setBuildSecrets([]);
      toast.success("Repository disconnected");
    } catch (error) {
      if (!handleLicenseApiError(error, "Git push-to-deploy")) {
        toast.error(error instanceof Error ? error.message : "Failed to disconnect repository");
      }
    } finally {
      setDisconnecting(false);
    }
  };

  if (suppliedLoading ?? loading) {
    return (
      <PanelShell title="Repository" description="Loading repository delivery settings…">
        <div className="h-28 animate-pulse bg-muted/30" />
      </PanelShell>
    );
  }

  if (error && !source) {
    return (
      <PanelShell
        title="Repository"
        description="Repository delivery settings could not be loaded."
      >
        <EmptyState message={error} actionLabel="Retry" onAction={onRetry} embedded />
      </PanelShell>
    );
  }

  if (!source) {
    return (
      <>
        <PanelShell
          title="Repository"
          description="Build and deploy this resource directly from a Git repository."
        >
          <EmptyState
            message="No repository connected. This resource continues to use its configured image."
            actionLabel="Connect repository"
            onAction={openConnect}
            embedded
          />
        </PanelShell>
        <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Connect repository</DialogTitle>
              <DialogDescription>
                {composeTarget
                  ? "Build every Compose service that declares build and apply the project only after all artifacts pass policy."
                  : "Build and deploy this Docker resource from an allowlisted repository."}
              </DialogDescription>
            </DialogHeader>
            <RepositorySourceFields
              connectorId={connectorId}
              connectorOptions={connectorOptions}
              repositories={repositories}
              repositoryOptions={repositories.map((repository) => ({
                value: repository.projectId,
                label: repository.fullPath,
                keywords: `${repository.name} ${repository.fullPath}`,
              }))}
              projectId={projectId}
              branch={connectBranch}
              dockerfilePath={connectDockerfilePath}
              contextPath={connectContextPath}
              composeFilePath={composeTarget ? connectComposeFilePath : undefined}
              autoBuild={connectAutoBuild}
              autoDeploy={connectAutoDeploy}
              onConnectorChange={(value) => {
                setConnectorId(value);
                setProjectId("");
              }}
              onProjectChange={setProjectId}
              onBranchChange={setConnectBranch}
              onDockerfilePathChange={setConnectDockerfilePath}
              onContextPathChange={setConnectContextPath}
              onComposeFilePathChange={composeTarget ? setConnectComposeFilePath : undefined}
              onAutoBuildChange={setConnectAutoBuild}
              onAutoDeployChange={setConnectAutoDeploy}
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setConnectOpen(false)} disabled={connecting}>
                Cancel
              </Button>
              <Button
                onClick={() => void connectSource()}
                disabled={
                  connecting ||
                  !connectorId ||
                  !projectId ||
                  !connectBranch.trim() ||
                  (composeTarget && !connectComposeFilePath.trim())
                }
              >
                {connecting ? "Connecting…" : "Connect"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  const lastSync = source.lastWebhookAt ?? source.lastResolvedAt;

  return (
    <div className="flex flex-col gap-4">
      <PanelShell
        title="Repository"
        description="Source and build settings used by this Docker resource."
        dirty={dirty}
        actions={
          <div className="flex items-center gap-2">
            <Button
              onClick={() => void save()}
              disabled={
                saving ||
                !dirty ||
                !branch.trim() ||
                (composeTarget
                  ? !composeFilePath.trim()
                  : !dockerfilePath.trim() || !contextPath.trim())
              }
            >
              <Save className="h-4 w-4" />
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button onClick={() => void triggerBuild()} disabled={building || dirty}>
              <Play className="h-4 w-4" />
              {building ? "Queuing…" : "Build now"}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Disconnect repository"
              title="Disconnect repository"
              disabled={disconnecting}
              onClick={() => void disconnectSource()}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        }
      >
        <SettingsControlRow
          title="Repository"
          description="Allowlisted project selected from the connected Git provider."
        >
          <span className="flex min-w-0 items-center gap-2 text-sm">
            <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{source.repositoryFullPath}</span>
          </span>
        </SettingsControlRow>
        <SettingsControlRow
          title="Git integration"
          description="Connection and credentials used for unattended checkout."
        >
          <Badge variant="secondary">{source.provider} integration</Badge>
        </SettingsControlRow>
        <SettingsControlRow
          title="Branch"
          description="New commits on this branch are eligible for build and deployment."
        >
          <Input
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            className="sm:w-72"
            placeholder="main"
          />
        </SettingsControlRow>
        {composeTarget ? (
          <SettingsControlRow
            title="Compose file"
            description="Repository-relative Compose file used to resolve all service builds."
          >
            <Input
              value={composeFilePath}
              onChange={(event) => setComposeFilePath(event.target.value)}
              className="sm:w-72"
              placeholder="compose.yaml"
            />
          </SettingsControlRow>
        ) : (
          <>
            <SettingsControlRow
              title="Dockerfile"
              description="Path to the Dockerfile relative to the repository root."
            >
              <Input
                value={dockerfilePath}
                onChange={(event) => setDockerfilePath(event.target.value)}
                className="sm:w-72"
                placeholder="Dockerfile"
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="Build context"
              description="Directory sent to BuildKit, relative to the repository root."
            >
              <Input
                value={contextPath}
                onChange={(event) => setContextPath(event.target.value)}
                className="sm:w-72"
                placeholder="."
              />
            </SettingsControlRow>
          </>
        )}
        <SettingsControlRow
          title="Automatic builds"
          description="Queue a build when a new commit is detected by webhook or polling."
        >
          <Switch checked={autoBuild} onChange={setAutoBuild} ariaLabel="Automatic builds" />
        </SettingsControlRow>
        <SettingsControlRow
          title="Automatic deployment"
          description="Roll out an approved artifact after its build succeeds."
        >
          <Switch checked={autoDeploy} onChange={setAutoDeploy} ariaLabel="Automatic deployment" />
        </SettingsControlRow>
        <SettingsControlRow
          title="Vulnerability policy"
          description="Minimum vulnerability severity that blocks an artifact from deployment."
        >
          <Select
            value={vulnerabilityThreshold}
            onValueChange={(value) => setVulnerabilityThreshold(value as VulnerabilityThreshold)}
          >
            <SelectTrigger className="sm:w-72" aria-label="Vulnerability policy">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="critical" description="Block critical findings.">
                Critical
              </SelectItem>
              <SelectItem value="high" description="Block high and critical findings.">
                High
              </SelectItem>
              <SelectItem value="medium" description="Block medium, high, and critical findings.">
                Medium
              </SelectItem>
              <SelectItem value="low" description="Block every known vulnerability severity.">
                Low
              </SelectItem>
              <SelectItem value="none" description="Report findings without blocking deployment.">
                Report only
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingsControlRow>
      </PanelShell>

      <PanelShell
        title="Build Secrets"
        description="Encrypted values exposed only through explicit BuildKit secret mounts."
        actions={
          <Button onClick={() => openBuildSecretDialog()}>
            <Plus className="h-4 w-4" />
            Add secret
          </Button>
        }
      >
        {buildSecrets.length === 0 ? (
          <EmptyState message="No Build Secrets configured." embedded />
        ) : (
          buildSecrets.map((secret) => (
            <SettingsControlRow
              key={secret.id}
              title={secret.name}
              description="Value is write-only and never returned by the API."
              onClick={() => openBuildSecretDialog(secret.name)}
            >
              <div className="flex items-center justify-end gap-2">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Replace ${secret.name}`}
                  title={`Replace ${secret.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openBuildSecretDialog(secret.name);
                  }}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Delete ${secret.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void removeBuildSecret(secret.name);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </SettingsControlRow>
          ))
        )}
      </PanelShell>

      <PanelShell
        title="Delivery status"
        description="Resolved and currently deployed repository revisions."
      >
        <SettingsControlRow
          title="Desired commit"
          description="Newest accepted commit resolved from the configured branch."
        >
          {commitBadge(source.desiredCommitSha, "No revision resolved")}
        </SettingsControlRow>
        <SettingsControlRow
          title="Deployed commit"
          description="Commit currently running on this Docker resource."
        >
          {commitBadge(source.deployedCommitSha, "No build deployed")}
        </SettingsControlRow>
        <SettingsControlRow
          title="Update detection"
          description="Gateway-managed trigger used to discover new commits."
        >
          <Badge variant="secondary">
            {source.webhookConfiguredAt ? "Webhook + polling" : "Polling"}
          </Badge>
        </SettingsControlRow>
        <SettingsControlRow
          title="Repository sync"
          description="Last successful provider event or repository reconciliation."
        >
          {source.lastPollError ? (
            <span className="text-sm text-destructive">Sync requires attention</span>
          ) : lastSync ? (
            <span className="text-sm">{new Date(lastSync).toLocaleString()}</span>
          ) : (
            <span className="text-sm text-muted-foreground">Waiting for first update</span>
          )}
        </SettingsControlRow>
        <SettingsControlRow
          title="Build inputs"
          description="Non-secret arguments and protected secrets supplied to the build."
        >
          <span className="text-right text-sm">
            <span className="block">{Object.keys(source.buildArgs).length} arguments</span>
            <span className="block text-xs text-muted-foreground">
              {source.buildSecretNames.length} protected secrets
            </span>
          </span>
        </SettingsControlRow>
      </PanelShell>

      <Dialog open={secretDialogOpen} onOpenChange={setSecretDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {buildSecrets.some((secret) => secret.name === secretName) ? "Replace" : "Add"} Build
              Secret
            </DialogTitle>
            <DialogDescription>
              Use the same ID in the Dockerfile with RUN --mount=type=secret. Existing values cannot
              be revealed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="build-secret-name">
                Secret ID
              </label>
              <Input
                id="build-secret-name"
                value={secretName}
                onChange={(event) => setSecretName(event.target.value)}
                placeholder="NPM_TOKEN"
                disabled={buildSecrets.some((secret) => secret.name === secretName)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="build-secret-value">
                Value
              </label>
              <Input
                id="build-secret-value"
                type="password"
                value={secretValue}
                onChange={(event) => setSecretValue(event.target.value)}
                autoComplete="new-password"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSecretDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void saveBuildSecret()}
              disabled={secretSaving || !secretName.trim() || !secretValue}
            >
              {secretSaving ? "Saving…" : "Save secret"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
