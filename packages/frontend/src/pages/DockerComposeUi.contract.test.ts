/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), "src", path), "utf8");

describe("Compose UI contract", () => {
  it("does not expose a standalone configure route", () => {
    const app = source("App.tsx");
    expect(app).not.toContain("/docker/compose/:projectId/configure");
  });

  it("uses shared dialogs, tables, tabs, and separate Variables instead of custom pages", () => {
    const list = source("pages/DockerComposeProjects.tsx");
    const detail = source("pages/DockerComposeProjectDetail.tsx");
    expect(list).toContain("<DialogContent");
    expect(detail).toContain("<DataTable");
    expect(detail).toContain('<TabsTrigger value="variables"');
    expect(detail).toContain("<ComposeVariablesTab");
    expect(detail).toContain("<ComposeProjectEditor");
  });

  it("leaves ordinary list and detail tabs to the shared page scroll owner", () => {
    const list = source("pages/DockerComposeProjects.tsx");
    const detail = source("pages/DockerComposeProjectDetail.tsx");
    expect(list).not.toContain("h-full space-y-4 overflow-y-auto p-6");
    expect(detail).toContain('usesInternalScroll ? "overflow-hidden" : "overflow-y-auto"');
    expect(detail).toContain("className={`flex h-full flex-col gap-4 p-6");
  });

  it("opens a Compose service through the canonical container name", () => {
    const detail = source("pages/DockerComposeProjectDetail.tsx");
    expect(detail).toContain("api.inspectContainer(project.nodeId, containerId, true)");
    expect(detail).toContain("dockerContainerRoute(node.slug, canonicalName, tab)");
    expect(detail).not.toContain("dockerContainerRoute(node.slug, containerId, tab)");
  });

  it("confirms list Stop actions and keeps Compose immediately after Containers", () => {
    const list = source("pages/DockerComposeProjects.tsx");
    const docker = source("pages/Docker.tsx");
    expect(list).toContain('action === "stop"');
    expect(list).toContain('confirmLabel: "Stop"');
    expect(list).toContain('variant: "destructive"');
    expect(docker.indexOf('{ value: "compose"')).toBeGreaterThan(
      docker.indexOf('{ value: "containers"')
    );
    expect(docker.indexOf('{ value: "compose"')).toBeLessThan(docker.indexOf('{ value: "images"'));
  });

  it("keeps discovery readable while routing every managed entry point through the shared paywall", () => {
    const list = source("pages/DockerComposeProjects.tsx");
    const detail = source("pages/DockerComposeProjectDetail.tsx");
    const editor = source("pages/compose/ComposeProjectEditor.tsx");
    expect(list).toContain('requireLicenseFeature("compose-applications", "Compose projects")');
    expect(list).toContain('requireLicenseFeature("compose-applications", "Compose adoption")');
    expect(list).toContain('requireLicenseFeature("compose-applications", "Compose lifecycle")');
    expect(detail).toContain('requireLicenseFeature("compose-applications", "Compose lifecycle")');
    expect(editor).toContain('requireLicenseFeature("compose-applications", "Compose projects")');
    expect(editor).toContain('requireLicenseFeature("git-push-to-deploy", "Git push-to-deploy")');
    expect(list).toContain("void fetchProjects(fixedNodeId)");
  });

  it("creates Compose projects from repositories with the shared repository controls", () => {
    const editor = source("pages/compose/ComposeProjectEditor.tsx");
    const repositoryFields = source("pages/docker-deploy/RepositorySourceFields.tsx");
    const api = source("services/api-docker-resources.ts");
    expect(editor).toContain('from "../docker-deploy/RepositorySourceFields"');
    expect(editor).toContain('value="repository" className="h-full px-3 py-0"');
    expect(editor).toContain('import { PanelShell } from "@/components/common/PanelShell"');
    expect(editor).toContain('import { AnimatedHeight } from "@/components/common/AnimatedHeight"');
    expect(editor).toContain('title="Compose YAML"');
    expect(editor).toContain('bodyClassName="h-[min(48dvh,440px)] min-h-72 overflow-hidden"');
    expect(editor).toContain("<AnimatePresence initial={false}>");
    expect(editor).not.toContain('mode="wait"');
    expect(editor).toContain(
      'className="grid gap-4 md:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]"'
    );
    const controls = editor.slice(
      editor.indexOf("md:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]"),
      editor.indexOf("<AnimatedHeight>")
    );
    expect(controls.indexOf("Source type")).toBeLessThan(controls.indexOf("Project name"));
    expect(editor).toContain('className="grid h-9 w-full grid-cols-2"');
    expect(editor).not.toContain("Compose runtime is unavailable on this node.");
    expect(editor).not.toContain('className="mt-3 text-xs text-destructive"');
    expect(editor).toContain("nodes.filter((node) => nodeSupportsCompose(node))");
    expect(editor).toContain(
      'throw new Error(sourceAdmission.message || "Build capacity is unavailable")'
    );
    expect(editor).not.toContain("sourceAdmission?.ready === false))");
    const list = source("pages/DockerComposeProjects.tsx");
    expect(list.match(/clipOverflow className="sm:max-w-2xl"/g)).toHaveLength(2);
    expect(editor).not.toContain("<TabsContent");
    expect(repositoryFields.match(/border border-border bg-muted\/30 p-3/g)).toHaveLength(2);
    expect(editor).toContain("createDockerComposeSourceProject");
    expect(editor).toContain("composeFilePath={sourceComposeFilePath}");
    expect(editor).toContain('"Create and build"');
    expect(api).toContain("/compose-projects/from-source");
  });

  it("refreshes Compose lists and details through the resource-scoped Compose event channel", () => {
    const list = source("pages/DockerComposeProjects.tsx");
    const detail = source("pages/DockerComposeProjectDetail.tsx");
    expect(list).toContain('useRealtime("docker.compose.changed"');
    expect(detail).toContain('useRealtime("docker.compose.changed"');
    expect(detail).toContain("event.projectId !== projectId");
  });

  it("keeps Compose list lifecycle actions visibly transitional until summaries converge", () => {
    const list = source("pages/DockerComposeProjects.tsx");
    expect(list).toContain('label: "starting" | "stopping" | "applying"');
    expect(list).toContain('action === "start" ? "starting"');
    expect(list).toContain('action === "stop" ? "stopping"');
    expect(list).toContain("operationId: operation.id");
    expect(list).toContain("window.setInterval(() => void fetchProjects(fixedNodeId), 1_000)");
    expect(list).toContain("!ACTIVE_OPERATION_STATUSES.has(operation.status)");
    expect(list).toContain('<Loader2 className="h-3 w-3 animate-spin" />');
    expect(list).toContain("disabled={Boolean(projectTransitions[project.id])}");
  });

  it("disables stopped monitoring and omits services without a running container", () => {
    const detail = source("pages/DockerComposeProjectDetail.tsx");
    expect(detail).toContain('project?.desiredState === "stopped" && activeTab === "monitoring"');
    expect(detail).toContain('setActiveTab("overview")');
    expect(detail).toContain('disabled={project.desiredState === "stopped"}');
    expect(detail).toContain('service.state === "running" && Boolean(service.containerIds[0])');
    expect(detail).toContain("<ComposeProcessesTable services={monitoredServices}");
    expect(detail).not.toContain("No runtime container is available for this service.");
  });

  it("uses shared empty state, default button sizing, and pulls the first project image", () => {
    const detail = source("pages/DockerComposeProjectDetail.tsx");
    const editor = source("pages/compose/ComposeProjectEditor.tsx");
    const table = source("components/ui/data-table.tsx");
    expect(table).toContain('import { EmptyState } from "@/components/common/EmptyState"');
    expect(table).toContain("<EmptyState message={emptyMessage} embedded={embedded} />");
    expect(detail).toContain("<Button onClick={() => setRevisionOpen(true)}>");
    expect(detail).not.toContain('<Button size="sm" onClick={() => setRevisionOpen(true)}>');
    expect(editor).toContain('const operationAction = projectId ? "apply" : "pull_apply"');
  });

  it("retains Activity details through the close animation and matches failed badge text", () => {
    const detail = source("pages/DockerComposeProjectDetail.tsx");
    expect(detail).toContain("open={activityDetailsOpen}");
    expect(detail).toContain("onAnimationEnd={(event) =>");
    expect(detail).toContain('event.currentTarget.dataset.state === "closed"');
    expect(detail).toContain('operation.error ? "text-red-600 dark:text-red-400"');
  });

  it("uses one explicit column sizing contract for Compose process headers and rows", () => {
    const detail = source("pages/DockerComposeProjectDetail.tsx");
    expect(detail).toContain("const PROCESS_COLUMN_WIDTHS");
    expect(detail.match(/processColumnStyle\(title, columnIndex, titles\)/g)).toHaveLength(2);
    expect(detail).toContain('PID: "88px"');
    expect(detail).toContain('USER: "140px"');
  });

  it("edits source Compose YAML while runtime overlays remain internal", () => {
    const detail = source("pages/DockerComposeProjectDetail.tsx");
    const editor = source("pages/compose/ComposeProjectEditor.tsx");
    const variables = source("pages/compose/ComposeVariablesTab.tsx");
    expect(detail).toContain("project.activeRevision.sourceYaml");
    expect(editor).toContain("loaded.activeRevision.sourceYaml");
    expect(variables).toContain("yaml: activeRevision.sourceYaml");
  });

  it("keeps editors bounded and portals Sonner above dialog overlays", () => {
    const editor = source("components/ui/code-editor.tsx");
    const sonner = source("components/ui/sonner.tsx");
    const animations = source("css/animations.css");
    expect(editor).toContain("...(height ? { height } : {})");
    expect(sonner).toContain("createPortal(toaster, document.body)");
    expect(sonner).toContain('"--z-index": "1000"');
    expect(animations).toContain("z-index: 1000 !important");
  });

  it("keeps Services content-sized and moves cursor-loaded Activity into Overview", () => {
    const detail = source("pages/DockerComposeProjectDetail.tsx");
    const api = source("services/api-docker.ts");
    expect(detail).toContain('new Set(["services", "configuration", "logs"]).has(activeTab)');
    expect(detail).toContain(
      '<TabsContent value="services" className="flex min-h-0 flex-1 flex-col pb-0">'
    );
    expect(detail).not.toContain('<TabsTrigger value="activity"');
    expect(detail).not.toContain('<TabsContent value="activity"');
    expect(detail).toContain('title="Recent activity"');
    expect(detail).toContain("columns={recentActivityColumns}");
    expect(detail).toContain("rows={recentActivity}");
    expect(detail).toContain("limit: 6");
    expect(detail).toContain("open={activityOpen}");
    expect(detail).toContain("scrollRef={activityScrollRef}");
    expect(detail).toContain("ref={activitySentinelRef}");
    expect(detail).toContain("activityNextCursor");
    expect(detail).toContain("sm:max-h-[92dvh] sm:max-w-5xl");
    expect(detail).toContain("max-h-[min(70dvh,44rem)] overflow-hidden");
    expect(
      detail.match(/h-fit w-full max-h-full \[&_\[data-route-scroll-container\]\]:flex-1/g)
    ).toHaveLength(1);
    expect(detail).not.toContain("End of activity history");
    expect(api).toContain("input: { cursor?: string; limit?: number } = {}");
  });

  it("keeps Compose overview headers and external project identity consistent", () => {
    const detail = source("pages/DockerComposeProjectDetail.tsx");
    const projects = source("pages/DockerComposeProjects.tsx");
    const externalBadge = source("components/docker/ExternalComposeBadge.tsx");
    expect(detail).toContain('title="Project"');
    expect(detail).toContain('icon={<Boxes className="h-4 w-4" />}');
    expect(detail).toContain('title="Runtime"');
    expect(detail).toContain('icon={<Activity className="h-4 w-4" />}');
    expect(detail).toContain('title="Recent activity"');
    expect(detail).toContain('icon={<History className="h-4 w-4" />}');
    expect(projects).toContain("<ExternalComposeBadge />");
    expect(projects).toContain("useRetainedDialogValue(");
    expect(projects).toContain("retainedAdoptEditorProject &&");
    expect(externalBadge).toContain('size="inline"');
    expect(externalBadge).toContain("Discovered on the Docker node but not managed by Gateway");
  });

  it("hides Compose folders and their containers from the general Containers tree", () => {
    const containers = source("pages/DockerContainers.tsx");
    expect(containers).toContain("const composeFolderIds = useMemo");
    expect(containers).toContain("const generalFolders = useMemo");
    expect(containers).toContain("const generalContainers = useMemo");
    expect(containers).toContain("attachContainersToFolders(generalFolders, filteredContainers)");
    expect(containers).toContain("collectFolderTreeIds(generalFolders)");
    expect(containers).not.toContain("renderFolderBadges");
  });
});
