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
