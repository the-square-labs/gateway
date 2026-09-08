import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../..", path), "utf8");
function inspect(path: string) {
  const text = source(path);
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = new Map<string, string>();
  const tags: string[] = [];
  const attributes: string[] = [];
  const elements: Array<{ tag: string; props: Map<string, string | true> }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const names = node.importClause?.namedBindings;
      if (names && ts.isNamedImports(names))
        for (const element of names.elements)
          imports.set(element.name.text, node.moduleSpecifier.text);
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      tags.push(node.tagName.getText(file));
      elements.push({
        tag: node.tagName.getText(file),
        props: new Map(
          node.attributes.properties
            .filter(ts.isJsxAttribute)
            .map((attr) => [
              attr.name.getText(file),
              attr.initializer && ts.isStringLiteral(attr.initializer)
                ? attr.initializer.text
                : (attr.initializer?.getText(file) ?? true),
            ])
        ),
      });
    }
    if (ts.isJsxAttribute(node)) attributes.push(node.name.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { text, imports, tags, attributes, elements };
}
const receipts: Array<[string, Record<string, string>]> = [
  [
    "pages/settings/HostingIntegrationsSection.tsx",
    {
      PanelShell: "@/components/common/PanelShell",
      Badge: "@/components/ui/badge",
    },
  ],
  [
    "pages/hosting/HostingConnectorDialog.tsx",
    {
      DialogContent: "@/components/ui/dialog",
      AnimatedHeight: "@/pages/notifications/template-editor",
      SettingsControlRow: "@/components/common/SettingsControlRow",
      PanelShell: "@/components/common/PanelShell",
    },
  ],
  [
    "pages/hosting/HostingIntegrationDetail.tsx",
    {
      PageTransition: "@/components/common/PageTransition",
      ResponsiveHeaderActions: "@/components/common/ResponsiveHeaderActions",
      StatCard: "@/components/ui/stat-card",
      Tabs: "@/components/ui/tabs",
      PanelShell: "@/components/common/PanelShell",
    },
  ],
  [
    "pages/hosting/HostingResourcesTab.tsx",
    {
      PanelShell: "@/components/common/PanelShell",
      SimpleTable: "@/components/common/SimpleTable",
      SettingsControlRow: "@/components/common/SettingsControlRow",
    },
  ],
  [
    "components/nodes/HostingNodeWizard.tsx",
    {
      DialogFooter: "@/components/ui/dialog",
      SettingsControlRow: "@/components/common/SettingsControlRow",
      PanelShell: "@/components/common/PanelShell",
    },
  ],
];

describe("hosting shared UI architecture contract", () => {
  it("keeps browser persistence and operation recovery out of hosting forms and VM actions", () => {
    for (const path of [
      "components/nodes/HostingNodeWizard.tsx",
      "components/nodes/NodeEnrollmentDialog.tsx",
      "lib/hosting-intents.ts",
      "pages/hosting/HostingResourcesTab.tsx",
    ]) {
      const text = source(path);
      expect(text).not.toMatch(/localStorage|sessionStorage/);
      expect(text).not.toContain("getHostingOperation(");
    }
  });
  it("reuses the interface choice, navigation attention and a single enrollment height animation", () => {
    const nodes = inspect("pages/AdminNodes.tsx");
    expect(nodes.imports.get("InterfaceChoiceDialog")).toBe(
      "@/components/ai/InterfaceChoiceDialog"
    );
    expect(nodes.tags).toContain("InterfaceChoiceDialog");
    expect(nodes.text).toContain('scrollTarget: "hosting-integrations"');
    const section = inspect("pages/settings/HostingIntegrationsSection.tsx");
    expect(section.imports.get("useScrollToNavigationTarget")).toBe(
      "@/hooks/use-scroll-to-navigation-target"
    );
    expect(
      section.elements.some(
        ({ tag, props }) => tag === "PanelShell" && props.get("id") === "hosting-integrations"
      )
    ).toBe(true);
    expect(section.text).toContain("navigation-target-ripple");
    const enrollment = inspect("components/nodes/NodeEnrollmentDialog.tsx");
    expect(enrollment.tags.filter((tag) => tag === "AnimatedHeight")).toHaveLength(1);
    expect(enrollment.text).not.toContain("RELAY_FIELD_ANIMATION");
    expect(enrollment.text).not.toMatch(/exit=|initial=\{\{/);
    expect(enrollment.imports.get("DialogContent")).toBe("@/components/ui/dialog");
  });
  it("keeps OS and per-VM resources in node creation, not connector defaults", () => {
    const connector = inspect("pages/hosting/HostingConnectorDialog.tsx");
    const wizard = inspect("components/nodes/HostingNodeWizard.tsx");
    expect(connector.text).not.toMatch(/defaultCpu|defaultMemoryMb|defaultDiskGb/);
    expect(
      connector.elements.some(
        ({ tag, props }) => tag === "Combobox" && props.get("ariaLabel") === "Template"
      )
    ).toBe(false);
    expect(connector.tags).not.toContain("EmptyState");
    expect(connector.imports.get("STEP_ANIMATION")).toBe("@/pages/notifications/template-editor");
    for (const label of ["vCPU", "Memory (MiB)", "Disk (GiB)"])
      expect(
        wizard.elements.some(
          ({ tag, props }) =>
            tag === "Input" && props.get("aria-label") === label && props.has("placeholder")
        )
      ).toBe(true);
    expect(wizard.text).not.toMatch(/error\s*&&\s*<EmptyState/);
    expect(wizard.text).not.toContain("quickCreate");
    expect(connector.text).toContain('item.content?.includes("import")');
  });
  it("matches connector layout, not only shared component imports", () => {
    const section = inspect("pages/settings/HostingIntegrationsSection.tsx");
    for (const element of section.elements.filter(({ tag }) => tag === "EmptyState"))
      expect(element.props.get("embedded")).toBe(true);
    expect(section.elements.find(({ tag }) => tag === "PanelShell")?.props.has("icon")).toBe(true);
    expect(section.tags).toContain("Plus");

    const dialog = inspect("pages/hosting/HostingConnectorDialog.tsx");
    const precedent = inspect("pages/settings/ExternalSshConnectorDialog.tsx");
    expect(dialog.elements.find(({ tag }) => tag === "DialogContent")?.props.get("className")).toBe(
      precedent.elements.find(({ tag }) => tag === "DialogContent")?.props.get("className")
    );
    for (const element of dialog.elements) {
      if (element.tag === "PanelShell") {
        expect(element.props.has("icon")).toBe(true);
        expect(element.props.has("description")).toBe(true);
      }
      if (element.tag === "Input" || element.tag === "Textarea")
        expect(element.props.has("placeholder")).toBe(true);
    }
    expect(
      dialog.elements.filter(({ tag, props }) => tag === "SettingsControlRow" && props.has("help"))
        .length
    ).toBeGreaterThan(10);
  });
  it("uses divided review rows and the product child-collection table composition", () => {
    for (const path of [
      "pages/hosting/HostingConnectorDialog.tsx",
      "components/nodes/HostingNodeWizard.tsx",
    ]) {
      const result = inspect(path);
      expect(result.tags).not.toContain("DetailRow");
      expect(result.tags).toContain("SettingsControlRow");
      for (const panel of result.elements.filter(({ tag }) => tag === "PanelShell")) {
        expect(panel.props.has("title")).toBe(true);
        expect(panel.props.has("icon")).toBe(true);
        expect(panel.props.has("description")).toBe(true);
      }
    }
    const resources = inspect("pages/hosting/HostingResourcesTab.tsx");
    expect(resources.tags.some((tag) => tag.startsWith("ResourceList"))).toBe(false);
    expect(
      resources.elements
        .filter(({ tag }) => tag === "Button")
        .some(({ props }) => props.get("size") === "sm")
    ).toBe(false);
    const menuButton = resources.elements.find(
      ({ tag, props }) => tag === "Button" && props.get("size") === "icon"
    );
    expect(menuButton?.props.get("variant")).toBe("ghost");
    expect(resources.text).not.toContain("no_evidence");
    const detail = source("pages/hosting/HostingIntegrationDetail.tsx");
    const file = ts.createSourceFile(
      "detail.tsx",
      detail,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const checkTabs = (node: ts.Node) => {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === "TabsTrigger")
        expect(
          node.children.some((child) => ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child))
        ).toBe(false);
      ts.forEachChild(node, checkTabs);
    };
    checkTabs(file);
  });
  it("matches connector row geometry to Cloudflare rather than settings form rows", () => {
    const hosting = inspect("pages/settings/HostingIntegrationsSection.tsx");
    const cloudflare = source("pages/settings/CloudflareIntegrationsSection.tsx");
    const row = hosting.elements.find(({ props }) => props.get("role") === "link");
    expect(row?.props.has("onClick")).toBe(true);
    expect(row?.props.has("onKeyDown")).toBe(true);
    expect(hosting.tags).not.toContain("SettingsControlRow");
    const geometry =
      "flex flex-col gap-3 p-4 transition-colors lg:flex-row lg:items-center lg:justify-between";
    expect(cloudflare).toContain(geometry);
    expect(row?.props.get("className")).toContain(geometry);
    expect(hosting.text).not.toMatch(/>\s*Open\s*<\/Button>/);
  });
  it("uses sentence case for every integration add button", () => {
    for (const file of ["Hosting", "ExternalSsh", "Cloudflare", "Git", ""])
      expect(source(`pages/settings/${file}IntegrationsSection.tsx`)).not.toContain(
        "Add Connector"
      );
  });
  it.each(receipts)("renders shared primitives directly in %s", (path, expected) => {
    const result = inspect(path);
    for (const [name, module] of Object.entries(expected)) {
      expect(result.imports.get(name), name).toBe(module);
      expect(result.tags, name).toContain(name);
    }
    expect(result.tags).not.toEqual(expect.arrayContaining(["table"]));
    for (const tag of ["table", "button", "input", "select", "textarea"])
      expect(result.tags).not.toContain(tag);
    expect(result.attributes).not.toContain("style");
    expect(result.text).not.toMatch(/(?:className|classNames)=[^\n]*\[\d/);
    expect(result.text).not.toMatch(
      /(?:function|const)\s+Hosting(?:Card|Shell|PageShell|Table|DialogShell)\b/
    );
  });
  it("embeds hosting in the existing external-node dialog rather than a parallel shell", () => {
    const wizard = inspect("components/nodes/HostingNodeWizard.tsx");
    expect(wizard.tags).not.toContain("DialogContent");
    expect(wizard.tags).not.toContain("FinalizeSetupWizardDialog");
    const enrollment = inspect("components/nodes/NodeEnrollmentDialog.tsx");
    expect(enrollment.tags).toContain("HostingNodeWizard");
    expect(enrollment.imports.get("useRetainedDialogValue")).toBe(
      "@/hooks/use-retained-dialog-value"
    );
    expect(
      enrollment.elements
        .filter(({ tag }) => tag === "TabsTrigger")
        .map(({ props }) => props.get("value"))
    ).toEqual(expect.arrayContaining(["external", "hosting"]));
    expect(wizard.text).toContain('className="space-y-1.5"');
    expect(wizard.text).toContain('className="text-sm font-medium"');
    expect(wizard.imports.get("STEP_ANIMATION")).toBe("@/pages/notifications/template-editor");
    expect(wizard.tags).toContain("AnimatePresence");
    expect(wizard.text).toContain("key={step}");
    expect(enrollment.tags).toContain("AnimatedHeight");
    expect(enrollment.text).toContain("key={effectiveMode}");
    expect(wizard.tags).toContain("SelectItem");
    expect(
      wizard.elements.some(({ tag, props }) => tag === "SelectItem" && props.has("description"))
    ).toBe(true);
  });
  it("keeps billing, usage and adoption tabs out of the node page", () => {
    const node = source("pages/AdminNodeDetail.tsx");
    expect(node).not.toMatch(/<TabsTrigger[^>]+value=["'](?:billing|finance|usage|adoption)["']/);
    expect(source("pages/hosting/HostingIntegrationDetail.tsx")).not.toMatch(
      /<TabsTrigger[^>]+value=["'](?:usage|adoption)["']/
    );
    for (const [path] of receipts)
      expect(source(path)).not.toMatch(
        /\b(?:adoptHostingNode|bindHostingNode|confirmAdoption|manualAdoption)\s*\(/
      );
  });
});
