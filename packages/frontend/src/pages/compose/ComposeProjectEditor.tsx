import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Loader2, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { PanelShell } from "@/components/common/PanelShell";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createClientUuid } from "@/lib/client-id";
import {
  canAdoptComposeProject,
  hasComposeNodeScope,
  hasComposeProjectScope,
} from "@/lib/compose-access";
import { loadVisibleDockerNodes } from "@/lib/docker-node-access";
import { dockerComposeProjectRoute } from "@/lib/resource-routes";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { handleLicenseApiError, requireLicenseFeature } from "@/stores/license-paywall";
import type { DockerBuildAdmissionStatus, DockerComposeProject, Node } from "@/types";
import { RepositorySourceFields } from "../docker-deploy/RepositorySourceFields";
import { useDockerSourceRepositories } from "../docker-deploy/useDockerSourceRepositories";

const DEFAULT_YAML = `services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
`;

const SOURCE_MODE_ANIMATION = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.15, ease: [0.25, 0.1, 0.25, 1] as const },
};

function nodeSupportsCompose(node: Node | undefined) {
  const capabilities = node?.capabilities as Record<string, unknown> | undefined;
  const advertised = Array.isArray(capabilities?.capabilities) ? capabilities.capabilities : [];
  return capabilities?.dockerComposeV1 === true || advertised.includes("docker_compose_v1");
}

function parseVariables(value: string): Record<string, string> {
  if (!value.trim()) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Variables must be a JSON object");
  return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]));
}

export function ComposeProjectEditor({
  onClose,
  defaultNodeId,
  projectIdOverride,
  adoptionOverride,
  compactRevision,
}: {
  onClose?: () => void;
  defaultNodeId?: string;
  projectIdOverride?: string;
  adoptionOverride?: boolean;
  compactRevision?: boolean;
} = {}) {
  const { projectId: routeProjectId } = useParams<{ projectId?: string }>();
  const projectId = projectIdOverride ?? routeProjectId;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { hasScopedAccess, user } = useAuthStore();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [project, setProject] = useState<DockerComposeProject | null>(null);
  const [nodeId, setNodeId] = useState(defaultNodeId ?? "");
  const [name, setName] = useState("");
  const [yaml, setYaml] = useState(DEFAULT_YAML);
  const [variablesText, setVariablesText] = useState("{}");
  const [sourceMode, setSourceMode] = useState<"yaml" | "repository">("yaml");
  const [sourceConnectorId, setSourceConnectorId] = useState("");
  const [sourceProjectId, setSourceProjectId] = useState("");
  const [sourceBranch, setSourceBranch] = useState("main");
  const [sourceComposeFilePath, setSourceComposeFilePath] = useState("compose.yaml");
  const [sourceAutoBuild, setSourceAutoBuild] = useState(true);
  const [sourceAutoDeploy, setSourceAutoDeploy] = useState(true);
  const [sourceAdmission, setSourceAdmission] = useState<DockerBuildAdmissionStatus | null>(null);
  const [loading, setLoading] = useState(!!projectId);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const adoption =
    adoptionOverride ||
    project?.managementState === "external" ||
    searchParams.get("adopt") === "1";
  const editing = !!projectId && !adoption;
  const canSubmit = projectId
    ? adoption
      ? canAdoptComposeProject(user?.scopes ?? [], nodeId, projectId)
      : hasComposeProjectScope(user?.scopes ?? [], "docker:compose:manage", nodeId, projectId)
    : !!nodeId && hasComposeNodeScope(user?.scopes ?? [], "docker:compose:create", nodeId);
  const repositoryCreation = !projectId && sourceMode === "repository";
  const { connectorOptions: sourceConnectorOptions, repositories: sourceRepositories } =
    useDockerSourceRepositories(repositoryCreation, sourceConnectorId);

  useEffect(() => {
    loadVisibleDockerNodes(
      user?.scopes ?? [],
      ["docker:compose:view"],
      hasScopedAccess("nodes:details")
    )
      .then((available) => {
        setNodes(available);
        if (!projectId) {
          const composeNodes = available.filter((node) => nodeSupportsCompose(node));
          const currentNodeIsAvailable = composeNodes.some((node) => node.id === nodeId);
          if (!currentNodeIsAvailable) {
            setNodeId(composeNodes.length === 1 ? composeNodes[0].id : "");
          }
        } else if (!nodeId && available.length === 1) {
          setNodeId(available[0].id);
        }
      })
      .catch(() => toast.error("Failed to load Docker nodes"));
  }, [hasScopedAccess, nodeId, projectId, user?.scopes]);

  useEffect(() => {
    if (!repositoryCreation || !nodeId) {
      setSourceAdmission(null);
      return;
    }
    let cancelled = false;
    setSourceAdmission(null);
    void api
      .getDockerBuildAdmission(nodeId)
      .then((status) => {
        if (!cancelled) setSourceAdmission(status);
      })
      .catch((error) => {
        if (!cancelled) {
          setSourceAdmission({
            ready: false,
            code: "BUILD_ADMISSION_CHECK_FAILED",
            message:
              error instanceof Error ? error.message : "Build capacity could not be verified",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId, repositoryCreation]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    api
      .listDockerComposeProjects()
      .then((projects) => projects.find((candidate) => candidate.id === projectId) ?? null)
      .then(async (summary) =>
        summary ? api.getDockerComposeProject(summary.nodeId, summary.id) : null
      )
      .then((loaded) => {
        if (cancelled) return;
        if (!loaded) throw new Error("Compose project not found");
        setProject(loaded);
        setNodeId(loaded.nodeId);
        setName(loaded.name);
        if (loaded.activeRevision) {
          setYaml(loaded.activeRevision.sourceYaml);
          setVariablesText(JSON.stringify(loaded.activeRevision.variables ?? {}, null, 2));
        }
      })
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : "Failed to load Compose project")
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const selectedNode = nodes.find((node) => node.id === nodeId);
  const supportsCompose = nodeSupportsCompose(selectedNode);
  const selectableNodes = useMemo(
    () => (projectId ? nodes : nodes.filter((node) => nodeSupportsCompose(node))),
    [nodes, projectId]
  );

  const input = useCallback(() => {
    const variables = parseVariables(variablesText);
    return {
      projectName: name.trim(),
      yaml,
      variables,
      secretKeys: project?.activeRevision?.secretKeys ?? [],
      secretValues: {},
    };
  }, [name, project?.activeRevision?.secretKeys, variablesText, yaml]);

  const validate = useCallback(
    async (notify = true) => {
      if (!nodeId || !name.trim() || !yaml.trim())
        throw new Error("Project name, node, and YAML are required");
      const values = input();
      setValidating(true);
      try {
        const result = await api.validateDockerComposeProject(nodeId, values);
        if (notify) {
          if (result.valid) {
            toast.success("Configuration is valid");
          } else {
            const firstDiagnostic = result.diagnostics[0];
            toast.error("Configuration is invalid", {
              description: firstDiagnostic
                ? `${firstDiagnostic.path ? `${firstDiagnostic.path}: ` : ""}${firstDiagnostic.message}${
                    result.diagnostics.length > 1 ? ` · ${result.diagnostics.length - 1} more` : ""
                  }`
                : undefined,
            });
          }
        }
        return result;
      } finally {
        setValidating(false);
      }
    },
    [input, name, nodeId, yaml]
  );

  const save = async () => {
    if (!requireLicenseFeature("compose-applications", "Compose projects")) return;
    if (repositoryCreation && !requireLicenseFeature("git-push-to-deploy", "Git push-to-deploy")) {
      return;
    }
    if (!canSubmit) {
      toast.error(
        adoption
          ? "Compose create and manage access are required to adopt this project"
          : "You do not have permission to apply this Compose configuration"
      );
      return;
    }
    if (!supportsCompose) {
      toast.error("Select a Docker node with Compose runtime available");
      return;
    }
    setSaving(true);
    try {
      if (repositoryCreation) {
        if (!name.trim() || !sourceConnectorId || !sourceProjectId || !sourceBranch.trim()) {
          throw new Error("Project name, repository, and branch are required");
        }
        if (!sourceComposeFilePath.trim()) throw new Error("Compose file path is required");
        if (sourceAdmission?.ready === false) {
          throw new Error(sourceAdmission.message || "Build capacity is unavailable");
        }
        const created = await api.createDockerComposeSourceProject(nodeId, {
          projectName: name.trim(),
          source: {
            connectorId: sourceConnectorId,
            projectId: sourceProjectId,
            branch: sourceBranch.trim(),
            dockerfilePath: "Dockerfile",
            contextPath: ".",
            composeFilePath: sourceComposeFilePath.trim(),
            composeVariables: {},
            composeSecretKeys: [],
            autoBuild: sourceAutoBuild,
            autoDeploy: sourceAutoDeploy,
            buildArgs: {},
            buildSecretNames: [],
            policy: { vulnerabilityThreshold: "critical" },
          },
        });
        toast.success("Compose build queued");
        navigate(dockerComposeProjectRoute(created.project.id), { replace: true });
        return;
      }
      const values = input();
      const result = await validate(false);
      if (!result.valid) throw new Error("Fix validation errors before applying");
      let targetProjectId = projectId;
      let revisionId: string | undefined;
      if (!projectId) {
        const created = await api.createDockerComposeProject(nodeId, values);
        targetProjectId = created.project.id;
        revisionId = created.revision.id;
      } else if (adoption) {
        const prepared = await api.adoptDockerComposeProject(nodeId, projectId, values);
        revisionId = prepared.revision.id;
      } else {
        const revision = await api.createDockerComposeRevision(nodeId, projectId, values);
        revisionId = revision.id;
      }
      if (!targetProjectId || !revisionId) throw new Error("Compose revision was not created");
      await api.startDockerComposeOperation(nodeId, targetProjectId, "apply", {
        revisionId,
        idempotencyKey: createClientUuid(),
      });
      toast.success(
        adoption
          ? "Adoption apply started"
          : editing
            ? "Revision apply started"
            : "Compose project apply started"
      );
      if (compactRevision && onClose) onClose();
      else navigate(dockerComposeProjectRoute(targetProjectId), { replace: true });
    } catch (error) {
      if (
        !handleLicenseApiError(
          error,
          repositoryCreation ? "Git push-to-deploy" : "Compose projects"
        )
      )
        toast.error(error instanceof Error ? error.message : "Failed to apply Compose project");
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );

  if (compactRevision && editing) {
    return (
      <div className="flex min-h-0 flex-col gap-4">
        <div className="h-[min(56dvh,560px)] min-h-80 overflow-hidden border border-border">
          <CodeEditor
            value={yaml}
            onChange={setYaml}
            language="yaml"
            minHeight="0"
            height="100%"
            bordered={false}
          />
        </div>
        <DialogFooter className="pt-1">
          <Button variant="outline" onClick={onClose} disabled={validating || saving}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => void validate().catch((error) => toast.error(error.message))}
            disabled={validating || saving}
          >
            {validating ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-1 h-4 w-4" />
            )}
            Validate
          </Button>
          <Button onClick={() => void save()} disabled={validating || saving || !canSubmit}>
            {saving ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-1 h-4 w-4" />
            )}
            Apply
          </Button>
        </DialogFooter>
      </div>
    );
  }

  if (onClose) {
    const yamlPanel = (
      <PanelShell
        title="Compose YAML"
        description="Images are required; build, host paths, privileged and swarm-only fields are rejected."
        bodyClassName="h-[min(48dvh,440px)] min-h-72 overflow-hidden"
      >
        <CodeEditor
          value={yaml}
          onChange={setYaml}
          language="yaml"
          minHeight="0"
          height="100%"
          bordered={false}
        />
      </PanelShell>
    );

    return (
      <div className="flex min-h-0 flex-col gap-4">
        {!projectId ? (
          <Tabs
            value={sourceMode}
            onValueChange={(value) => setSourceMode(value as "yaml" | "repository")}
            className="flex min-h-0 flex-col gap-4"
          >
            <div className="grid gap-4 md:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]">
              <div className="space-y-1.5">
                <span className="block text-sm font-medium">Source type</span>
                <TabsList className="grid h-9 w-full grid-cols-2">
                  <TabsTrigger value="yaml" className="h-full px-3 py-0">
                    Compose YAML
                  </TabsTrigger>
                  <TabsTrigger value="repository" className="h-full px-3 py-0">
                    Repository
                  </TabsTrigger>
                </TabsList>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="compose-name-modal" className="text-sm font-medium">
                  Project name
                </label>
                <Input
                  id="compose-name-modal"
                  value={name}
                  onChange={(event) => setName(event.target.value.toLowerCase())}
                  placeholder="my-project"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Target node</label>
                <Select
                  value={nodeId}
                  onValueChange={setNodeId}
                  disabled={
                    !!defaultNodeId && selectableNodes.some((node) => node.id === defaultNodeId)
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select node" />
                  </SelectTrigger>
                  <SelectContent>
                    {selectableNodes.map((node) => (
                      <SelectItem key={node.id} value={node.id}>
                        {node.displayName || node.hostname}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <AnimatedHeight>
              <AnimatePresence initial={false}>
                <motion.div key={sourceMode} {...SOURCE_MODE_ANIMATION} className="overflow-hidden">
                  {sourceMode === "yaml" ? (
                    yamlPanel
                  ) : (
                    <div>
                      <RepositorySourceFields
                        connectorId={sourceConnectorId}
                        connectorOptions={sourceConnectorOptions}
                        repositories={sourceRepositories}
                        repositoryOptions={sourceRepositories.map((repository) => ({
                          value: repository.projectId,
                          label: repository.fullPath,
                          keywords: `${repository.name} ${repository.fullPath}`,
                        }))}
                        projectId={sourceProjectId}
                        branch={sourceBranch}
                        dockerfilePath="Dockerfile"
                        contextPath="."
                        composeFilePath={sourceComposeFilePath}
                        autoBuild={sourceAutoBuild}
                        autoDeploy={sourceAutoDeploy}
                        onConnectorChange={(value) => {
                          setSourceConnectorId(value);
                          setSourceProjectId("");
                        }}
                        onProjectChange={setSourceProjectId}
                        onBranchChange={setSourceBranch}
                        onDockerfilePathChange={() => {}}
                        onContextPathChange={() => {}}
                        onComposeFilePathChange={setSourceComposeFilePath}
                        onAutoBuildChange={setSourceAutoBuild}
                        onAutoDeployChange={setSourceAutoDeploy}
                      />
                    </div>
                  )}
                </motion.div>
              </AnimatePresence>
            </AnimatedHeight>
          </Tabs>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="compose-name-modal" className="text-sm font-medium">
                  Project name
                </label>
                <Input id="compose-name-modal" value={name} disabled />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Target node</label>
                <Select value={nodeId} disabled>
                  <SelectTrigger>
                    <SelectValue placeholder="Select node" />
                  </SelectTrigger>
                  <SelectContent>
                    {nodes.map((node) => (
                      <SelectItem key={node.id} value={node.id}>
                        {node.displayName || node.hostname}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {yamlPanel}
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={validating || saving}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => void validate().catch((error) => toast.error(error.message))}
            disabled={validating || saving || repositoryCreation}
          >
            {validating ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-1 h-4 w-4" />
            )}
            Validate
          </Button>
          <Button onClick={() => void save()} disabled={validating || saving || !canSubmit}>
            {saving ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-1 h-4 w-4" />
            )}
            {repositoryCreation
              ? "Create and build"
              : adoption
                ? "Adopt & Apply"
                : editing
                  ? "Apply"
                  : "Deploy"}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return null;
}
