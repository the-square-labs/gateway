import { describe, expect, it } from "vitest";
import { resolveAIWorkspaceEntry, resolveInterfaceTransition } from "./DashboardLayout";

describe("resolveInterfaceTransition", () => {
  it("opens Operations Console with the current conversation in the AI side panel", () => {
    expect(resolveInterfaceTransition("operations_console", true)).toEqual({
      path: "/",
      aiPanelOpen: true,
    });
  });

  it("does not force the AI panel open when Operations Console is selected during onboarding", () => {
    expect(resolveInterfaceTransition("operations_console")).toEqual({
      path: null,
      aiPanelOpen: null,
    });
  });

  it("opens AI Workspace without the Operations Console side panel", () => {
    expect(resolveInterfaceTransition("ai_workspace")).toEqual({
      path: "/",
      aiPanelOpen: false,
    });
  });
});

describe("resolveAIWorkspaceEntry", () => {
  it("reopens configuration instead of entering a non-renderable Workspace", () => {
    expect(resolveAIWorkspaceEntry(true, true, true, false)).toBe("needs_configuration");
  });

  it("opens a configured and enabled Workspace", () => {
    expect(resolveAIWorkspaceEntry(true, true, true, true)).toBe("open");
  });

  it("preserves the no-access state for users without the Workspace scope", () => {
    expect(resolveAIWorkspaceEntry(true, false, false, true)).toBe("no_access");
  });
});
