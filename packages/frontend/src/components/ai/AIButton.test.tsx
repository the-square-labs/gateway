import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAIStore } from "@/stores/ai";
import { useAuthStore } from "@/stores/auth";
import { useUIStore } from "@/stores/ui";
import { makeUser } from "@/test/fixtures";
import { AI_SCOPE } from "@/types";
import { AIButton } from "./AIButton";

describe("AIButton", () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: makeUser({ scopes: [] }),
      isAuthenticated: true,
      isLoading: false,
    });
    useAIStore.setState({ isEnabled: true });
    useUIStore.setState({ aiLiteMode: false, aiPanelOpen: false });
  });

  it("stays visible and requests the availability dialog without Workspace access", () => {
    const onOpenAIWorkspace = vi.fn();
    window.addEventListener("gateway:open-ai-workspace", onOpenAIWorkspace);

    render(
      <TooltipProvider>
        <AIButton />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByRole("button"));

    expect(onOpenAIWorkspace).toHaveBeenCalledOnce();
    expect(useUIStore.getState().aiPanelOpen).toBe(false);
    window.removeEventListener("gateway:open-ai-workspace", onOpenAIWorkspace);
  });

  it("requests the availability dialog when AI is globally disabled", () => {
    useAuthStore.setState({ user: makeUser({ scopes: [AI_SCOPE] }) });
    useAIStore.setState({ isEnabled: false });
    const onOpenAIWorkspace = vi.fn();
    window.addEventListener("gateway:open-ai-workspace", onOpenAIWorkspace);

    render(
      <TooltipProvider>
        <AIButton />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByRole("button"));

    expect(onOpenAIWorkspace).toHaveBeenCalledOnce();
    expect(useUIStore.getState().aiPanelOpen).toBe(false);
    window.removeEventListener("gateway:open-ai-workspace", onOpenAIWorkspace);
  });

  it("opens the Operations Console side panel from the header star", () => {
    useAuthStore.setState({ user: makeUser({ scopes: [AI_SCOPE] }) });

    render(
      <TooltipProvider>
        <AIButton />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByRole("button"));

    expect(useUIStore.getState().aiPanelOpen).toBe(true);
  });

  it("renders the expanded sidebar CTA and keeps it actionable without Workspace access", () => {
    const onOpenAIWorkspace = vi.fn();
    window.addEventListener("gateway:open-ai-workspace", onOpenAIWorkspace);

    render(
      <TooltipProvider>
        <AIButton showLabel />
      </TooltipProvider>
    );

    const button = screen.getByRole("button", { name: "AI Workspace" });
    expect(button).toHaveClass("bg-sidebar-accent");
    fireEvent.click(button);

    expect(onOpenAIWorkspace).toHaveBeenCalledOnce();
    expect(useUIStore.getState().aiPanelOpen).toBe(false);
    window.removeEventListener("gateway:open-ai-workspace", onOpenAIWorkspace);
  });

  it("opens the full Workspace from the expanded sidebar CTA when access is available", () => {
    useAuthStore.setState({ user: makeUser({ scopes: [AI_SCOPE] }) });
    const onOpenAIWorkspace = vi.fn();
    window.addEventListener("gateway:open-ai-workspace", onOpenAIWorkspace);

    render(
      <TooltipProvider>
        <AIButton showLabel />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "AI Workspace" }));

    expect(onOpenAIWorkspace).toHaveBeenCalledOnce();
    expect(useUIStore.getState().aiPanelOpen).toBe(false);
    window.removeEventListener("gateway:open-ai-workspace", onOpenAIWorkspace);
  });
});
