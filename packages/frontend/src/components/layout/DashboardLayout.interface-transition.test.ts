import { describe, expect, it } from "vitest";
import {
  resolveAccessibleInterface,
  resolveAIWorkspaceEntry,
  resolveInterfaceTransition,
  shouldOpenAIConversationInConsole,
} from "./DashboardLayout";

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

describe("shouldOpenAIConversationInConsole", () => {
  it("preserves a persisted chat after the user wrote in it", () => {
    expect(
      shouldOpenAIConversationInConsole("conversation-1", [
        { role: "user", content: "Check the node" },
        { role: "assistant", content: "Working on it" },
      ])
    ).toBe(true);
  });

  it("does not open the panel for an empty or merely opened chat", () => {
    expect(shouldOpenAIConversationInConsole(null, [])).toBe(false);
    expect(
      shouldOpenAIConversationInConsole("conversation-1", [
        { role: "assistant", content: "Welcome" },
      ])
    ).toBe(false);
  });
});

describe("resolveAccessibleInterface", () => {
  it("forces Operations Console when the Workspace scope is missing", () => {
    expect(resolveAccessibleInterface(null, false)).toBe("operations_console");
    expect(resolveAccessibleInterface("ai_workspace", false)).toBe("operations_console");
  });

  it("preserves the stored choice for users with Workspace access", () => {
    expect(resolveAccessibleInterface("ai_workspace", true)).toBe("ai_workspace");
    expect(resolveAccessibleInterface(null, true)).toBeNull();
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
