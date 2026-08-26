import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("Docker Git delivery UI structure", () => {
  it("uses the existing Docker list, filter, select, and build detail primitives", () => {
    const builds = source("./DockerBuilds.tsx");
    expect(builds).toContain('from "@/components/common/SearchFilterBar"');
    expect(builds).toContain('from "@/components/ui/data-table"');
    expect(builds).toContain('from "@/components/ui/select"');
    expect(builds).toContain('from "./docker-detail/DockerBuildDetailsDialog"');
    expect(builds).not.toContain('from "@/components/common/Combobox"');
    expect(builds).not.toContain('header: "Build Worker"');
    expect(builds).toContain("listDockerBuildPage");
    expect(builds).toContain("Scroll to load older builds");
    expect(builds).not.toContain("View all");
    expect(builds).toContain('header: "SHA"');
    expect(builds).toContain("build.artifact.digest.slice(0, 19)");
    expect(builds).toContain('"Deployment completed"');
    expect(builds).not.toContain('size="sm"');
    expect(builds).not.toContain("embedded={embedded}");
  });

  it("uses settings rows for editable source configuration and a shared details dialog", () => {
    const sourcePanel = source("./docker-detail/DockerGitSourcePanel.tsx");
    const history = source("./docker-detail/DockerBuildHistoryPanel.tsx");
    expect(sourcePanel).toContain('from "@/components/common/PanelShell"');
    expect(sourcePanel).toContain('from "@/components/common/SettingsControlRow"');
    expect(sourcePanel).toContain('aria-label="Vulnerability policy"');
    expect(sourcePanel).toContain('ariaLabel="Automatic builds"');
    expect(sourcePanel).toContain('ariaLabel="Automatic deployment"');
    expect(sourcePanel).toContain('title="Build Secrets"');
    expect(sourcePanel).not.toContain('ariaLabel="Require SBOM"');
    expect(sourcePanel).not.toContain('ariaLabel="Require provenance"');
    expect(sourcePanel).not.toContain('size="sm"');
    const resourceTabs = source("./docker-detail/DockerResourceGitTabs.tsx");
    expect(resourceTabs).toContain("hasActiveBuilds ? 5_000 : 15_000");
    expect(resourceTabs).toContain("if (!document.hidden) void refreshBuilds()");
    expect(history).toContain('from "@/components/common/SimpleTable"');
    expect(history).toContain('from "@/components/ui/data-table"');
    expect(history).toContain('from "./DockerBuildDetailsDialog"');
    expect(history).toContain("View all");
    expect(history).toContain("listDockerBuildPage");
    expect(history).not.toContain('minWidth="54rem"');
    expect(history).not.toContain("horizontalScroll");
  });

  it("consolidates container build history into Source while retaining deployment tabs", () => {
    const containerDetail = source("./DockerContainerDetail.tsx");
    const deploymentDetail = source("./DockerDeploymentDetail.tsx");

    const containerTabs = containerDetail.slice(
      containerDetail.indexOf("const visibleTabs = useMemo"),
      containerDetail.indexOf(
        "const isTabDisabled",
        containerDetail.indexOf("const visibleTabs = useMemo")
      )
    );
    expect(containerTabs).toContain('"source"');
    expect(containerTabs).not.toContain('"builds"');
    expect(containerTabs).toContain('"config"');
    expect(containerDetail).toContain("includeBuilds");
    expect(containerDetail).toContain('className="pb-6"');
    expect(containerDetail).toContain('label: "View config"');
    expect(containerDetail).toContain("alwaysOverflow: true");
    expect(containerDetail).not.toContain('<TabsTrigger value="builds"');

    const deploymentTabs = deploymentDetail.slice(
      deploymentDetail.indexOf("const visibleTabs = useMemo"),
      deploymentDetail.indexOf(
        "const isTabDisabled",
        deploymentDetail.indexOf("const visibleTabs = useMemo")
      )
    );
    expect(deploymentTabs).toContain('"source"');
    expect(deploymentTabs).toContain('"builds"');
  });

  it("reuses the shared repository and build surfaces for Compose projects", () => {
    const composeDetail = source("./DockerComposeProjectDetail.tsx");
    const resourceTabs = source("./docker-detail/DockerResourceGitTabs.tsx");
    const sourcePanel = source("./docker-detail/DockerGitSourcePanel.tsx");

    expect(composeDetail).toContain('from "./docker-detail/DockerResourceGitTabs"');
    expect(composeDetail).toContain('<TabsTrigger value="source"');
    expect(composeDetail).toContain('<TabsTrigger value="builds"');
    expect(composeDetail).toContain('kind: "compose_project"');
    expect(resourceTabs).toContain('kind: "compose_project"');
    expect(sourcePanel).toContain('from "../docker-deploy/RepositorySourceFields"');
    expect(sourcePanel).toContain('from "../docker-deploy/useDockerSourceRepositories"');
    expect(resourceTabs).toContain("onSourceChange={setSource}");
    expect(sourcePanel).toContain('title="Compose file"');
    expect(sourcePanel).toContain('requireLicenseFeature("git-push-to-deploy"');
  });

  it("reuses the same repository and build surfaces for Pages projects", () => {
    const pageDetail = source("./pages/PageProjectDetail.tsx");
    const resourceTabs = source("./docker-detail/DockerResourceGitTabs.tsx");
    const sourcePanel = source("./docker-detail/DockerGitSourcePanel.tsx");

    expect(pageDetail).toContain('from "../docker-detail/DockerResourceGitTabs"');
    expect(pageDetail).toContain('<TabsTrigger value="source"');
    expect(pageDetail).toContain('<TabsTrigger value="builds"');
    expect(pageDetail).toContain('kind: "pages_project"');
    const pagesSourceTab = pageDetail.slice(
      pageDetail.indexOf('<TabsContent value="source"'),
      pageDetail.indexOf('<TabsContent value="builds"')
    );
    expect(pagesSourceTab).not.toContain("includeBuilds");
    expect(resourceTabs).toContain('kind: "pages_project"');
    expect(sourcePanel).toContain('title="Application root"');
    expect(sourcePanel).toContain('title="Build Variables"');
    expect(sourcePanel).toContain('title="Build Secrets"');
    expect(sourcePanel).toContain("onSourceChange?.(connected)");
    expect(sourcePanel).toContain("VITE_* values are public build variables");
    expect(pageDetail).not.toMatch(/from ["'].+Page(?:Git|Build)Source/);
  });

  it("uses the shared inline copy action in Pages Deployment details", () => {
    const deployments = source("./pages/PageDeploymentsTab.tsx");
    const pageDetail = source("./pages/PageProjectDetail.tsx");

    expect(deployments).toContain('from "@/components/common/CopyButton"');
    expect(deployments).toContain('label="immutable preview URL"');
    expect(deployments).toContain("h-auto w-auto bg-transparent p-0");
    expect(deployments).toContain('iconClassName="h-3 w-3"');
    expect(pageDetail).toContain(
      "rounded-none border-l bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
    );
  });

  it("uses the established icon pattern for Pages tabs and section headers", () => {
    const pageDetail = source("./pages/PageProjectDetail.tsx");
    const deployments = source("./pages/PageDeploymentsTab.tsx");
    const tags = source("./pages/PageTagsTab.tsx");
    const tokens = source("./pages/PageTokensTab.tsx");
    const configuration = source("./pages/PageRuntimeConfigTab.tsx");
    const sourcePanel = source("./docker-detail/DockerGitSourcePanel.tsx");
    const builds = source("./docker-detail/DockerBuildHistoryPanel.tsx");

    expect(pageDetail).toContain('<TabsTrigger value="deployments" className="gap-1.5">');
    expect(pageDetail).toContain('<PackageOpen className="h-3.5 w-3.5" /> Deployments');
    expect(pageDetail).toContain('<GitBranch className="h-3.5 w-3.5" /> Source');
    expect(pageDetail).toContain('<Hammer className="h-3.5 w-3.5" /> Builds');
    expect(pageDetail).toContain('<Tags className="h-3.5 w-3.5" /> Tags');
    expect(pageDetail).toContain('<KeyRound className="h-3.5 w-3.5" /> Deploy tokens');
    expect(pageDetail).toContain('<Code2 className="h-3.5 w-3.5" /> Configuration');
    expect(deployments).toContain('icon={<PackageOpen className="h-4 w-4" />}');
    expect(tags).toContain('icon={<Tags className="h-4 w-4" />}');
    expect(tokens).toContain('icon={<KeyRound className="h-4 w-4" />}');
    expect(configuration).toContain('icon={<Code2 className="h-4 w-4" />}');
    expect(sourcePanel).toContain('icon={<GitBranch className="h-4 w-4" />}');
    expect(sourcePanel).toContain('icon={<Braces className="h-4 w-4" />}');
    expect(sourcePanel).toContain('icon={<KeyRound className="h-4 w-4" />}');
    expect(sourcePanel).toContain('icon={<History className="h-4 w-4" />}');
    expect(builds).toContain('icon={<Hammer className="h-4 w-4" />}');
  });

  it("uses Lucide icons for every top-level Integration section", () => {
    const gitLab = source("./settings/IntegrationsSection.tsx");
    const git = source("./settings/GitIntegrationsSection.tsx");
    const cloudflare = source("./settings/CloudflareIntegrationsSection.tsx");
    const ssh = source("./settings/ExternalSshIntegrationsSection.tsx");

    expect(gitLab).toContain('icon={<Gitlab className="h-4 w-4" />}');
    expect(git).toContain('icon={<Icon className="h-4 w-4" />}');
    expect(cloudflare).toContain('icon={<Cloud className="h-4 w-4" />}');
    expect(ssh).toContain('icon={<KeyRound className="h-4 w-4" />}');
  });

  it("uses the shared animated two-step flow for connecting a Pages repository", () => {
    const sourcePanel = source("./docker-detail/DockerGitSourcePanel.tsx");
    const repository = source("./docker-deploy/RepositorySourceFields.tsx");
    const buildFields = sourcePanel.slice(
      sourcePanel.indexOf("const pagesBuildFields"),
      sourcePanel.indexOf("return (", sourcePanel.indexOf("const pagesBuildFields"))
    );

    expect(sourcePanel).toContain('from "@/components/common/AnimatedHeight"');
    expect(sourcePanel).toContain("const [connectStep, setConnectStep] = useState<1 | 2>(1)");
    expect(sourcePanel).toContain('className={pagesTarget ? "sm:max-w-lg" : "sm:max-w-2xl"}');
    expect(sourcePanel).toContain("<AnimatedHeight>");
    expect(sourcePanel).toContain('<AnimatePresence initial={false} mode="popLayout">');
    expect(sourcePanel).toContain("if (await discoverPagesBuild()) setConnectStep(2)");
    expect(sourcePanel).toContain("Loading package.json…");
    expect(sourcePanel).toContain("<ArrowLeft");
    expect(sourcePanel).toContain("<ArrowRight");
    expect(repository).toContain('? "space-y-4"');
    expect(buildFields).not.toContain("grid-cols");
  });

  it("shares the container log viewport with build dialogs", () => {
    const logs = source("./docker-detail/LogsTab.tsx");
    const details = source("./docker-detail/DockerBuildDetailsDialog.tsx");
    expect(logs).toContain('from "./DockerLogViewport"');
    expect(details).toContain('from "./DockerLogViewport"');
    expect(details).toContain('from "@/components/common/PanelShell"');
    expect(details).toContain("Vulnerabilities");
    expect(details).not.toContain('<MetaRow label="Result">');
  });

  it("keeps internal registry settings in Features and reuses domain controls", () => {
    const settings = source("./Settings.tsx");
    const registry = source("./settings/InternalRegistrySection.tsx");
    const advanced = settings.slice(
      settings.indexOf('<TabsContent value="advanced"'),
      settings.indexOf('<TabsContent value="relay"')
    );
    const features = settings.slice(
      settings.indexOf('<TabsContent value="features"'),
      settings.indexOf('<TabsContent value="integrations"')
    );
    expect(advanced).not.toContain("<InternalRegistrySection");
    expect(features).toContain("<InternalRegistrySection");
    expect(registry).toContain('from "@/components/domains/DomainAutocompleteInput"');
    expect(registry).toContain('from "@/components/common/SettingsControlRow"');
    expect(registry).not.toContain("gap-2 border-t border-border px-4 py-3");
    expect(registry).not.toContain('size="sm"');
  });

  it("enrolls Build Workers through the existing Docker installer profile", () => {
    const wizard = source("./dashboard/finalize-setup/NodeSetupWizard.tsx");
    expect(wizard).toContain('value: "builder"');
    expect(wizard).toContain('builder: "setup-docker-node.sh"');
    expect(wizard).toContain("--mode builder");
  });

  it("extends the existing deploy dialog with shared source controls", () => {
    const dialog = source("./DockerDeployDialog.tsx");
    const fields = source("./docker-deploy/DockerDeployFormFields.tsx");
    const repository = source("./docker-deploy/RepositorySourceFields.tsx");
    const data = source("./docker-deploy/useDockerDeployData.ts");
    const deploySurface = `${dialog}\n${fields}\n${repository}\n${data}`;
    expect(fields).toContain('from "@/components/common/AnimatedHeight"');
    expect(deploySurface).toContain('from "@/components/common/Combobox"');
    expect(fields).toContain('from "@/components/ui/tabs"');
    expect(repository).toContain('from "@/components/ui/switch"');
    expect(fields).toContain('<SelectTrigger aria-label="Resource type">');
    expect(fields).toContain("<AnimatedHeight>");
    expect(fields).toContain('mode="popLayout"');
    expect(fields).not.toContain("initial={{ height: 0");
    expect(fields).toContain('value="repository"');
    expect(fields.indexOf("{/* Node */}")).toBeLessThan(fields.indexOf("<RepositorySourceFields"));
    expect(fields.indexOf('aria-label="Runtime"')).toBeLessThan(
      fields.indexOf("<RepositorySourceFields")
    );
    expect(
      deploySurface.match(/sm:grid-cols-\[minmax\(0,7fr\)_minmax\(0,3fr\)\]/g)?.length
    ).toBeGreaterThanOrEqual(2);
    expect(dialog).toContain("Create and build");
    expect(data).toContain("getDockerBuildAdmission");
    expect(fields).toContain('role="alert"');
    expect(deploySurface).not.toContain("space-y-4 border border-border bg-card p-4");
  });
});
