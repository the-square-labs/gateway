import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  Braces,
  GitBranch,
  History,
  KeyRound,
  Loader2,
  Pencil,
  Play,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
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
import { ApiRequestError } from "@/services/api-base";
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
  onSourceChange?: (source: DockerSourceBinding | null) => void;
  composeVariables?: Record<string, string>;
  composeSecretKeys?: string[];
  canEdit?: boolean;
  canBuild?: boolean;
}

type VulnerabilityThreshold = "critical" | "high" | "medium" | "low" | "none";

const CONNECT_STEP_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

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
  onSourceChange,
  composeVariables = {},
  composeSecretKeys = [],
  canEdit = true,
  canBuild = true,
}: DockerGitSourcePanelProps) {
  const navigate = useNavigate();
  const [source, setSource] = useState<DockerSourceBinding | null>(suppliedSource ?? null);
  const [loading, setLoading] = useState(suppliedSource === undefined);
  const [saving, setSaving] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildWorkerRequiredOpen, setBuildWorkerRequiredOpen] = useState(false);
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
  const [applicationRoot, setApplicationRoot] = useState(suppliedSource?.applicationRoot ?? ".");
  const [packageManager, setPackageManager] = useState<"npm" | "pnpm" | "yarn">(
    suppliedSource?.packageManager ?? "npm"
  );
  const [packageManagerVersion, setPackageManagerVersion] = useState(
    suppliedSource?.packageManagerVersion ?? ""
  );
  const [nodeVersion, setNodeVersion] = useState<"20" | "22" | "24">(
    suppliedSource?.nodeVersion ?? "24"
  );
  const [buildScript, setBuildScript] = useState(suppliedSource?.buildScript ?? "build");
  const [artifactDirectory, setArtifactDirectory] = useState(
    suppliedSource?.artifactDirectory ?? "dist"
  );
  const [publishTag, setPublishTag] = useState(suppliedSource?.publishTag ?? "production");
  const [buildVariables, setBuildVariables] = useState<Record<string, string>>(
    suppliedSource?.buildArgs ?? {}
  );
  const [variableDialogOpen, setVariableDialogOpen] = useState(false);
  const [variableName, setVariableName] = useState("");
  const [variableValue, setVariableValue] = useState("");
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
  const [connectStep, setConnectStep] = useState<1 | 2>(1);
  const [connecting, setConnecting] = useState(false);
  const [connectorId, setConnectorId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [connectBranch, setConnectBranch] = useState("main");
  const [connectDockerfilePath, setConnectDockerfilePath] = useState("Dockerfile");
  const [connectContextPath, setConnectContextPath] = useState(".");
  const [connectComposeFilePath, setConnectComposeFilePath] = useState("compose.yaml");
  const [connectAutoBuild, setConnectAutoBuild] = useState(true);
  const [connectAutoDeploy, setConnectAutoDeploy] = useState(true);
  const [connectApplicationRoot, setConnectApplicationRoot] = useState(".");
  const [connectPackageManager, setConnectPackageManager] = useState<"npm" | "pnpm" | "yarn">(
    "npm"
  );
  const [connectPackageManagerVersion, setConnectPackageManagerVersion] = useState("");
  const [connectNodeVersion, setConnectNodeVersion] = useState<"20" | "22" | "24">("24");
  const [connectBuildScript, setConnectBuildScript] = useState("");
  const [connectArtifactDirectory, setConnectArtifactDirectory] = useState("dist");
  const [connectPublishTag, setConnectPublishTag] = useState("production");
  const [discoveryScripts, setDiscoveryScripts] = useState<Record<string, string>>({});
  const [discoveryManagers, setDiscoveryManagers] = useState<Array<"npm" | "pnpm" | "yarn">>([]);
  const [discovering, setDiscovering] = useState(false);
  const targetKind = target?.kind;
  const targetNodeId = target?.nodeId;
  const targetResourceId =
    target?.kind === "container"
      ? target.containerName
      : target?.kind === "deployment"
        ? target.deploymentId
        : target?.kind === "compose_project"
          ? target.composeProjectId
          : target?.pageProjectId;
  const composeTarget = target?.kind === "compose_project";
  const pagesTarget = target?.kind === "pages_project";
  const { connectorOptions, repositories } = useDockerSourceRepositories(
    connectOpen,
    connectorId,
    target
  );
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
          : targetKind === "compose_project"
            ? { kind: "compose_project", nodeId: targetNodeId!, composeProjectId: targetResourceId }
            : { kind: "pages_project", nodeId: targetNodeId, pageProjectId: targetResourceId };
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
          : targetKind === "compose_project"
            ? { kind: "compose_project", nodeId: targetNodeId!, composeProjectId: targetResourceId }
            : { kind: "pages_project", nodeId: targetNodeId, pageProjectId: targetResourceId };
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
    setApplicationRoot(source.applicationRoot || ".");
    setPackageManager(source.packageManager ?? "npm");
    setPackageManagerVersion(source.packageManagerVersion ?? "");
    setNodeVersion(source.nodeVersion ?? "24");
    setBuildScript(source.buildScript ?? "build");
    setArtifactDirectory(source.artifactDirectory ?? "dist");
    setPublishTag(source.publishTag ?? "production");
    setBuildVariables(source.buildArgs);
  }, [source]);

  const dirty = Boolean(
    source &&
      (branch !== source.branch ||
        (composeTarget
          ? composeFilePath !== (source.composeFilePath ?? "compose.yaml")
          : dockerfilePath !== source.dockerfilePath || contextPath !== source.contextPath) ||
        autoBuild !== source.autoBuild ||
        autoDeploy !== source.autoDeploy ||
        vulnerabilityThreshold !== (source.policy?.vulnerabilityThreshold ?? "critical") ||
        (pagesTarget &&
          (applicationRoot !== source.applicationRoot ||
            packageManager !== source.packageManager ||
            packageManagerVersion !== (source.packageManagerVersion ?? "") ||
            nodeVersion !== source.nodeVersion ||
            buildScript !== source.buildScript ||
            artifactDirectory !== source.artifactDirectory ||
            publishTag !== source.publishTag ||
            JSON.stringify(buildVariables) !== JSON.stringify(source.buildArgs))))
  );

  const save = async () => {
    if (!canEdit) return;
    if (
      !source ||
      !branch.trim() ||
      (composeTarget
        ? !composeFilePath.trim()
        : pagesTarget
          ? !applicationRoot.trim() ||
            !buildScript.trim() ||
            !artifactDirectory.trim() ||
            !publishTag.trim()
          : !dockerfilePath.trim() || !contextPath.trim())
    )
      return;
    setSaving(true);
    try {
      if (!target) return;
      const updated = await api.upsertDockerSource(target, {
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
        buildArgs: pagesTarget ? buildVariables : source.buildArgs,
        buildSecretNames: source.buildSecretNames,
        applicationRoot: pagesTarget ? applicationRoot.trim() : undefined,
        packageManager: pagesTarget ? packageManager : undefined,
        packageManagerVersion:
          pagesTarget && packageManagerVersion.trim() ? packageManagerVersion.trim() : undefined,
        nodeVersion: pagesTarget ? nodeVersion : undefined,
        buildScript: pagesTarget ? buildScript.trim() : undefined,
        artifactDirectory: pagesTarget ? artifactDirectory.trim() : undefined,
        publishTag: pagesTarget ? publishTag.trim() : undefined,
        policy: {
          ...source.policy,
          vulnerabilityThreshold: pagesTarget ? "none" : vulnerabilityThreshold,
        },
      });
      setSource(updated);
      onSourceChange?.(updated);
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
    if (!canEdit) return;
    if (!requireLicenseFeature("git-push-to-deploy", "Git push-to-deploy")) return;
    setConnectStep(1);
    setConnectOpen(true);
  };

  const connectSource = async () => {
    if (!canEdit) return;
    if (!target || !connectorId || !projectId || !connectBranch.trim()) return;
    if (composeTarget && !connectComposeFilePath.trim()) return;
    if (
      pagesTarget &&
      (!connectApplicationRoot.trim() ||
        !connectBuildScript.trim() ||
        !connectArtifactDirectory.trim() ||
        !connectPublishTag.trim())
    )
      return;
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
        applicationRoot: pagesTarget ? connectApplicationRoot.trim() : undefined,
        packageManager: pagesTarget ? connectPackageManager : undefined,
        packageManagerVersion:
          pagesTarget && connectPackageManagerVersion.trim()
            ? connectPackageManagerVersion.trim()
            : undefined,
        nodeVersion: pagesTarget ? connectNodeVersion : undefined,
        buildScript: pagesTarget ? connectBuildScript.trim() : undefined,
        artifactDirectory: pagesTarget ? connectArtifactDirectory.trim() : undefined,
        publishTag: pagesTarget ? connectPublishTag.trim() : undefined,
        policy: { vulnerabilityThreshold: pagesTarget ? "none" : "critical" },
      });
      setSource(connected);
      onSourceChange?.(connected);
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

  const clearPagesBuildDiscovery = () => {
    setDiscoveryScripts({});
    setDiscoveryManagers([]);
    setConnectBuildScript("");
    setConnectPackageManagerVersion("");
  };

  const discoverPagesBuild = async (): Promise<boolean> => {
    if (!pagesTarget || !target || !connectorId || !projectId || !connectBranch.trim()) {
      return false;
    }
    setDiscovering(true);
    try {
      const discovery = await api.discoverPagesBuild(target.pageProjectId, {
        connectorId,
        projectId,
        branch: connectBranch.trim(),
        applicationRoot: connectApplicationRoot.trim() || ".",
      });
      setDiscoveryScripts(discovery.scripts);
      setDiscoveryManagers(discovery.packageManagers);
      if (discovery.preferredPackageManager) {
        setConnectPackageManager(discovery.preferredPackageManager);
      }
      setConnectPackageManagerVersion(discovery.packageManagerVersion ?? "");
      const scriptNames = Object.keys(discovery.scripts);
      setConnectBuildScript(
        discovery.scripts.build ? "build" : scriptNames.length === 1 ? scriptNames[0]! : ""
      );
      toast.success("package.json loaded");
      return true;
    } catch (error) {
      clearPagesBuildDiscovery();
      toast.error(error instanceof Error ? error.message : "Failed to inspect package.json");
      return false;
    } finally {
      setDiscovering(false);
    }
  };

  const continuePagesConnect = async () => {
    if (await discoverPagesBuild()) setConnectStep(2);
  };

  const saveBuildVariable = () => {
    const name = variableName.trim();
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      toast.error("Variable name must be a valid environment variable name");
      return;
    }
    setBuildVariables((current) => ({ ...current, [name]: variableValue }));
    setVariableDialogOpen(false);
  };

  const removeBuildVariable = (name: string) => {
    setBuildVariables((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
  };

  const saveBuildSecret = async () => {
    if (!canEdit) return;
    const name = secretName.trim();
    if (!name || !secretValue || !source) return;
    if (pagesTarget && name.startsWith("VITE_")) {
      toast.error("VITE_* values are public build variables, not Build Secrets");
      return;
    }
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
    if (!canEdit) return;
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
    if (!canBuild) return;
    if (!source) return;
    if (!target) return;
    setBuilding(true);
    try {
      await api.createDockerSourceBuild(target, { force: true });
      toast.success("Build queued");
      onBuildQueued?.();
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "NO_BUILD_WORKER_AVAILABLE") {
        setBuildWorkerRequiredOpen(true);
        return;
      }
      if (!handleLicenseApiError(error, "Git push-to-deploy")) {
        toast.error(error instanceof Error ? error.message : "Failed to queue build");
      }
    } finally {
      setBuilding(false);
    }
  };

  const disconnectSource = async () => {
    if (!canEdit) return;
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
      onSourceChange?.(null);
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
      <PanelShell
        icon={<GitBranch className="h-4 w-4" />}
        title="Repository"
        description="Loading repository delivery settings…"
      >
        <div className="h-28 animate-pulse bg-muted/30" />
      </PanelShell>
    );
  }

  if (error && !source) {
    return (
      <PanelShell
        icon={<GitBranch className="h-4 w-4" />}
        title="Repository"
        description="Repository delivery settings could not be loaded."
      >
        <EmptyState message={error} actionLabel="Retry" onAction={onRetry} embedded />
      </PanelShell>
    );
  }

  if (!source) {
    const repositorySourceFields = (
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
        pages={pagesTarget}
        autoBuild={connectAutoBuild}
        autoDeploy={connectAutoDeploy}
        onConnectorChange={(value) => {
          setConnectorId(value);
          setProjectId("");
          if (pagesTarget) clearPagesBuildDiscovery();
        }}
        onProjectChange={(value) => {
          setProjectId(value);
          if (pagesTarget) clearPagesBuildDiscovery();
        }}
        onBranchChange={(value) => {
          setConnectBranch(value);
          if (pagesTarget) clearPagesBuildDiscovery();
        }}
        onDockerfilePathChange={setConnectDockerfilePath}
        onContextPathChange={setConnectContextPath}
        onComposeFilePathChange={composeTarget ? setConnectComposeFilePath : undefined}
        onAutoBuildChange={setConnectAutoBuild}
        onAutoDeployChange={setConnectAutoDeploy}
      />
    );

    const pagesBuildFields = (
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Package manager</label>
          <Select
            value={connectPackageManager}
            onValueChange={(value) => setConnectPackageManager(value as "npm" | "pnpm" | "yarn")}
          >
            <SelectTrigger aria-label="Package manager">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(discoveryManagers.length > 0
                ? discoveryManagers
                : (["npm", "pnpm", "yarn"] as const)
              ).map((manager) => (
                <SelectItem key={manager} value={manager}>
                  {manager}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Node.js</label>
          <Select
            value={connectNodeVersion}
            onValueChange={(value) => setConnectNodeVersion(value as "20" | "22" | "24")}
          >
            <SelectTrigger aria-label="Node.js version">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="20">Node.js 20</SelectItem>
              <SelectItem value="22">Node.js 22</SelectItem>
              <SelectItem value="24">Node.js 24</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Build script</label>
          <Select value={connectBuildScript} onValueChange={setConnectBuildScript}>
            <SelectTrigger aria-label="Build script">
              <SelectValue placeholder="Select build script" />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(discoveryScripts).map(([name, command]) => (
                <SelectItem key={name} value={name} description={command}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="pages-artifact-directory">
            Artifact directory
          </label>
          <Input
            id="pages-artifact-directory"
            value={connectArtifactDirectory}
            onChange={(event) => setConnectArtifactDirectory(event.target.value)}
            placeholder="dist"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="pages-publish-tag">
            Publish Tag
          </label>
          <Input
            id="pages-publish-tag"
            value={connectPublishTag}
            onChange={(event) => setConnectPublishTag(event.target.value)}
            placeholder="production"
          />
        </div>
      </div>
    );

    return (
      <>
        <PanelShell
          icon={<GitBranch className="h-4 w-4" />}
          title="Repository"
          description="Build and deploy this resource directly from a Git repository."
        >
          <EmptyState
            message={
              pagesTarget
                ? "No repository connected. This Project continues to accept manual Deployments."
                : "No repository connected. This resource continues to use its configured image."
            }
            actionLabel={canEdit ? "Connect repository" : undefined}
            onAction={canEdit ? openConnect : undefined}
            embedded
          />
        </PanelShell>
        <Dialog
          open={connectOpen}
          onOpenChange={(open) => {
            setConnectOpen(open);
            if (!open) setConnectStep(1);
          }}
        >
          <DialogContent className={pagesTarget ? "sm:max-w-lg" : "sm:max-w-2xl"}>
            <DialogHeader>
              <DialogTitle>Connect repository</DialogTitle>
              <DialogDescription>
                {pagesTarget
                  ? connectStep === 1
                    ? "Choose the repository and application root for this Pages Project."
                    : "Configure how Gateway builds and publishes the Pages artifact."
                  : composeTarget
                    ? "Build every Compose service that declares build and apply the project only after all artifacts pass policy."
                    : "Build and deploy this Docker resource from an allowlisted repository."}
              </DialogDescription>
            </DialogHeader>
            {pagesTarget ? (
              <AnimatedHeight>
                <AnimatePresence initial={false} mode="popLayout">
                  {connectStep === 1 ? (
                    <motion.div
                      key="pages-source-step"
                      {...CONNECT_STEP_ANIMATION}
                      className="space-y-4"
                    >
                      {repositorySourceFields}
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium" htmlFor="pages-application-root">
                          Application root
                        </label>
                        <Input
                          id="pages-application-root"
                          value={connectApplicationRoot}
                          onChange={(event) => {
                            setConnectApplicationRoot(event.target.value);
                            clearPagesBuildDiscovery();
                          }}
                          placeholder="."
                        />
                      </div>
                    </motion.div>
                  ) : (
                    <motion.div key="pages-build-step" {...CONNECT_STEP_ANIMATION}>
                      {pagesBuildFields}
                    </motion.div>
                  )}
                </AnimatePresence>
              </AnimatedHeight>
            ) : (
              repositorySourceFields
            )}
            <DialogFooter>
              {pagesTarget && connectStep === 1 ? (
                <>
                  <Button
                    variant="outline"
                    onClick={() => setConnectOpen(false)}
                    disabled={discovering}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={() => void continuePagesConnect()}
                    disabled={
                      discovering ||
                      !connectorId ||
                      !projectId ||
                      !connectBranch.trim() ||
                      !connectApplicationRoot.trim()
                    }
                  >
                    {discovering ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading package.json…
                      </>
                    ) : (
                      <>
                        Continue
                        <ArrowRight className="h-4 w-4" />
                      </>
                    )}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="outline"
                    onClick={() => {
                      if (pagesTarget) setConnectStep(1);
                      else setConnectOpen(false);
                    }}
                    disabled={connecting}
                  >
                    {pagesTarget ? (
                      <>
                        <ArrowLeft className="h-4 w-4" />
                        Back
                      </>
                    ) : (
                      "Cancel"
                    )}
                  </Button>
                  <Button
                    onClick={() => void connectSource()}
                    disabled={
                      connecting ||
                      !connectorId ||
                      !projectId ||
                      !connectBranch.trim() ||
                      (composeTarget && !connectComposeFilePath.trim()) ||
                      (pagesTarget &&
                        (!connectBuildScript ||
                          !connectApplicationRoot.trim() ||
                          !connectArtifactDirectory.trim() ||
                          !connectPublishTag.trim()))
                    }
                  >
                    {connecting ? "Connecting…" : "Connect"}
                  </Button>
                </>
              )}
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
        icon={<GitBranch className="h-4 w-4" />}
        title="Repository"
        description={
          pagesTarget
            ? "Source and build settings used by this Pages Project."
            : "Source and build settings used by this Docker resource."
        }
        dirty={dirty}
        actions={
          <div className="flex items-center gap-2">
            {canEdit && (
              <Button
                onClick={() => void save()}
                disabled={
                  saving ||
                  !dirty ||
                  !branch.trim() ||
                  (composeTarget
                    ? !composeFilePath.trim()
                    : pagesTarget
                      ? !applicationRoot.trim() ||
                        !buildScript.trim() ||
                        !artifactDirectory.trim() ||
                        !publishTag.trim()
                      : !dockerfilePath.trim() || !contextPath.trim())
                }
              >
                <Save className="h-4 w-4" />
                {saving ? "Saving…" : "Save"}
              </Button>
            )}
            {canBuild && (
              <Button onClick={() => void triggerBuild()} disabled={building || dirty}>
                <Play className="h-4 w-4" />
                {building ? "Queuing…" : "Build now"}
              </Button>
            )}
            {canEdit && (
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
            )}
          </div>
        }
      >
        <SettingsControlRow
          title="Repository"
          description="Allowlisted project selected from the connected Git provider."
          help="The repository Gateway checks out when it builds this Pages Project. Access is provided by the selected Git integration."
        >
          <span className="flex min-w-0 items-center gap-2 text-sm">
            <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{source.repositoryFullPath}</span>
          </span>
        </SettingsControlRow>
        <SettingsControlRow
          title="Git integration"
          description="Connection and credentials used for unattended checkout."
          help="The saved Git provider connection Gateway uses to read the repository, resolve commits, receive webhooks, and download source code without an interactive login."
        >
          <Badge variant="secondary">{source.provider} integration</Badge>
        </SettingsControlRow>
        <SettingsControlRow
          title="Branch"
          description="New commits on this branch are eligible for build and deployment."
          help="Gateway watches this branch for new commits. Automatic builds use its latest accepted commit; manual builds also start from this branch."
        >
          <Input
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            className="sm:w-72"
            placeholder="main"
            disabled={!canEdit}
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
              disabled={!canEdit}
            />
          </SettingsControlRow>
        ) : pagesTarget ? (
          <>
            <SettingsControlRow
              title="Application root"
              description="Repository-relative directory containing package.json."
              help="The builder changes into this directory before installing dependencies and running the build script. Use a repository-relative path such as . or apps/web."
            >
              <Input
                value={applicationRoot}
                onChange={(event) => setApplicationRoot(event.target.value)}
                className="sm:w-72"
                placeholder="."
                disabled={!canEdit}
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="Package manager"
              description="Dependency installer and package.json script executor."
              help="Gateway uses this tool for dependency installation and to run the selected package.json build script inside the isolated builder."
            >
              <Select
                value={packageManager}
                onValueChange={(value) => setPackageManager(value as "npm" | "pnpm" | "yarn")}
                disabled={!canEdit}
              >
                <SelectTrigger className="sm:w-72" aria-label="Package manager">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="npm">npm</SelectItem>
                  <SelectItem value="pnpm">pnpm</SelectItem>
                  <SelectItem value="yarn">yarn</SelectItem>
                </SelectContent>
              </Select>
            </SettingsControlRow>
            <SettingsControlRow
              title="Node.js"
              description="Managed Node.js runtime used by the isolated builder."
              help="The Node.js major version available while dependencies are installed and the Pages application is built. It does not control the browser runtime."
            >
              <Select
                value={nodeVersion}
                onValueChange={(value) => setNodeVersion(value as "20" | "22" | "24")}
                disabled={!canEdit}
              >
                <SelectTrigger className="sm:w-72" aria-label="Node.js version">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="20">Node.js 20</SelectItem>
                  <SelectItem value="22">Node.js 22</SelectItem>
                  <SelectItem value="24">Node.js 24</SelectItem>
                </SelectContent>
              </Select>
            </SettingsControlRow>
            <SettingsControlRow
              title="Build script"
              description="package.json script executed after dependency installation."
              help="The script name from package.json scripts, without the package-manager command. For example, enter build for npm run build."
            >
              <Input
                value={buildScript}
                onChange={(event) => setBuildScript(event.target.value)}
                className="sm:w-72"
                placeholder="build"
                disabled={!canEdit}
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="Artifact directory"
              description="Directory published relative to the Application root."
              help="The build output Gateway packages and serves as the Pages deployment. Typical values are dist, build, or out."
            >
              <Input
                value={artifactDirectory}
                onChange={(event) => setArtifactDirectory(event.target.value)}
                className="sm:w-72"
                placeholder="dist"
                disabled={!canEdit}
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="Publish Tag"
              description="Successful builds move this existing Pages Tag."
              help="After a successful build, Gateway publishes the new immutable deployment to this Tag. Routes and runtime configuration can target the Tag by name."
            >
              <Input
                value={publishTag}
                onChange={(event) => setPublishTag(event.target.value)}
                className="sm:w-72"
                placeholder="production"
                disabled={!canEdit}
              />
            </SettingsControlRow>
          </>
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
                disabled={!canEdit}
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
                disabled={!canEdit}
              />
            </SettingsControlRow>
          </>
        )}
        <SettingsControlRow
          title="Automatic builds"
          description="Queue a build when a new commit is detected by webhook or polling."
          help="When enabled, Gateway queues a build after the configured branch advances. Disabling it keeps the repository connected but requires manual builds."
        >
          <Switch
            checked={autoBuild}
            onChange={setAutoBuild}
            ariaLabel="Automatic builds"
            disabled={!canEdit}
          />
        </SettingsControlRow>
        {!pagesTarget && (
          <SettingsControlRow
            title="Automatic deployment"
            description="Roll out an approved artifact after its build succeeds."
          >
            <Switch
              checked={autoDeploy}
              onChange={setAutoDeploy}
              ariaLabel="Automatic deployment"
              disabled={!canEdit}
            />
          </SettingsControlRow>
        )}
        {!pagesTarget && (
          <SettingsControlRow
            title="Vulnerability policy"
            description="Minimum vulnerability severity that blocks an artifact from deployment."
          >
            <Select
              value={vulnerabilityThreshold}
              onValueChange={(value) => setVulnerabilityThreshold(value as VulnerabilityThreshold)}
              disabled={!canEdit}
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
        )}
      </PanelShell>

      {pagesTarget && (
        <PanelShell
          icon={<Braces className="h-4 w-4" />}
          title="Build Variables"
          description="Build-time environment values. VITE_* values are embedded in the published client bundle."
          dirty={JSON.stringify(buildVariables) !== JSON.stringify(source.buildArgs)}
          actions={
            canEdit ? (
              <Button
                onClick={() => {
                  setVariableName("");
                  setVariableValue("");
                  setVariableDialogOpen(true);
                }}
              >
                <Plus className="h-4 w-4" />
                Add variable
              </Button>
            ) : undefined
          }
        >
          {Object.keys(buildVariables).length === 0 ? (
            <EmptyState message="No Build Variables configured." embedded />
          ) : (
            Object.entries(buildVariables)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([name, value]) => (
                <SettingsControlRow
                  key={name}
                  title={name}
                  description={
                    name.startsWith("VITE_")
                      ? "Public in the built client bundle."
                      : "Build-time environment variable."
                  }
                  onClick={
                    canEdit
                      ? () => {
                          setVariableName(name);
                          setVariableValue(value);
                          setVariableDialogOpen(true);
                        }
                      : undefined
                  }
                >
                  {canEdit && (
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Edit ${name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setVariableName(name);
                          setVariableValue(value);
                          setVariableDialogOpen(true);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Delete ${name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          removeBuildVariable(name);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </SettingsControlRow>
              ))
          )}
        </PanelShell>
      )}

      <PanelShell
        icon={<KeyRound className="h-4 w-4" />}
        title="Build Secrets"
        description={
          pagesTarget
            ? "Encrypted write-only values exposed to dependency installation and the selected build script. Use only with trusted repository code."
            : "Encrypted values exposed only through explicit BuildKit secret mounts."
        }
        actions={
          canEdit ? (
            <Button onClick={() => openBuildSecretDialog()}>
              <Plus className="h-4 w-4" />
              Add secret
            </Button>
          ) : undefined
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
              onClick={canEdit ? () => openBuildSecretDialog(secret.name) : undefined}
            >
              {canEdit && (
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
              )}
            </SettingsControlRow>
          ))
        )}
      </PanelShell>

      <PanelShell
        icon={<History className="h-4 w-4" />}
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
              {pagesTarget
                ? "The value is exposed only to the isolated build process. VITE_* names are public and must use Build Variables."
                : "Use the same ID in the Dockerfile with RUN --mount=type=secret. Existing values cannot be revealed."}
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
      <Dialog open={variableDialogOpen} onOpenChange={setVariableDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {Object.hasOwn(buildVariables, variableName) ? "Edit" : "Add"} Build Variable
            </DialogTitle>
            <DialogDescription>
              Build Variables are readable configuration. VITE_* values are embedded in the static
              client bundle.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="build-variable-name">
                Name
              </label>
              <Input
                id="build-variable-name"
                value={variableName}
                onChange={(event) => setVariableName(event.target.value)}
                placeholder="VITE_API_URL"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="build-variable-value">
                Value
              </label>
              <Input
                id="build-variable-value"
                value={variableValue}
                onChange={(event) => setVariableValue(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVariableDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveBuildVariable} disabled={!variableName.trim()}>
              Save variable
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={buildWorkerRequiredOpen} onOpenChange={setBuildWorkerRequiredOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Connect a Build Worker first</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Repository builds run on a connected Build Worker. Add a Build Worker node first, then
            return here to queue the build.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBuildWorkerRequiredOpen(false)}>
              Close
            </Button>
            <Button
              onClick={() => {
                setBuildWorkerRequiredOpen(false);
                navigate("/nodes");
              }}
            >
              Open Nodes <ArrowRight className="h-4 w-4" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
