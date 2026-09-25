import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageTransition } from "@/components/common/PageTransition";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/services/api";
import { useAIStore } from "@/stores/ai";
import { renderWithRouter } from "@/test/render";
import type { AIProviderStatus, AIScenario } from "@/types/ai";
import { AILitePanel } from "./AILitePanel";
import { AIWorkspaceScenarioStart } from "./AIWorkspaceScenarioStart";

const scenario: AIScenario = {
  id: "deploy",
  category: "deploy_release",
  title: "Deploy a service",
  description: "Ship a container to a node.",
  icon: "rocket",
};

const providerStatus = {
  enabled: true,
  providerType: "openai_compatible",
  allowUserReasoningEffortSelection: false,
  models: [],
} as unknown as AIProviderStatus;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function renderLitePanel(options?: { route?: string; path?: string }) {
  return renderWithRouter(
    <TooltipProvider>
      <PageTransition>
        <AILitePanel />
      </PageTransition>
    </TooltipProvider>,
    options
  );
}

function pageTransition() {
  return document.querySelector<HTMLElement>("[data-page-transition]");
}

const initialAIState = useAIStore.getState();

describe("AILitePanel first render", () => {
  beforeEach(() => {
    vi.spyOn(api, "getAIScenarios").mockResolvedValue([scenario]);
    vi.spyOn(api, "getFinalizeSetupState").mockResolvedValue(null);
    vi.spyOn(api, "getDashboardBootstrap").mockRejectedValue(new Error("offline"));
    vi.spyOn(api, "getAIContextEstimate").mockRejectedValue(new Error("offline"));
    act(() => {
      useAIStore.setState({
        messages: [],
        activeConversationId: null,
        recentConversations: [],
        isConnected: true,
        isStreaming: false,
        retryAfter: null,
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    act(() => {
      useAIStore.setState(initialAIState, true);
    });
  });

  it("reveals the workspace once the provider controls and the start screen are ready", async () => {
    const providerRequest = deferred<void>();
    act(() => {
      useAIStore.setState({
        providerStatus: null,
        refreshProviderStatus: vi.fn(() => providerRequest.promise),
      });
    });

    renderLitePanel();

    // The start screen data arrives first; the page still waits for the provider.
    expect(await screen.findByText("Deploy a service")).toBeInTheDocument();
    expect(pageTransition()).toHaveStyle({ visibility: "hidden" });

    await act(async () => {
      useAIStore.setState({ providerStatus });
      providerRequest.resolve();
    });

    await waitFor(() => expect(pageTransition()).toHaveStyle({ visibility: "visible" }));
    expect(screen.getByRole("button", { name: /Deploy a service/ })).toBeVisible();
  });

  it("does not wait for the provider when its status is already cached", async () => {
    act(() => {
      useAIStore.setState({
        providerStatus,
        refreshProviderStatus: vi.fn(() => new Promise<void>(() => {})),
      });
    });

    renderLitePanel();

    await waitFor(() => expect(pageTransition()).toHaveStyle({ visibility: "visible" }));
    expect(screen.getByRole("button", { name: /Deploy a service/ })).toBeVisible();
  });

  it("opens a linked conversation without showing the start screen first", async () => {
    const conversationRequest = deferred<void>();
    const loadConversation = vi.fn(() => conversationRequest.promise);
    act(() => {
      useAIStore.setState({
        providerStatus,
        refreshProviderStatus: vi.fn().mockResolvedValue(undefined),
        loadConversation,
      });
    });

    renderLitePanel({ route: "/ai/chats/conversation-1", path: "/ai/chats/:conversationId" });

    await waitFor(() => expect(loadConversation).toHaveBeenCalledWith("conversation-1"));
    await screen.findByText("Deploy a service");
    expect(pageTransition()).toHaveStyle({ visibility: "hidden" });

    await act(async () => {
      useAIStore.setState({
        activeConversationId: "conversation-1",
        messages: [{ id: "user-1", role: "user", content: "Check the proxy" }],
      });
      conversationRequest.resolve();
    });

    await waitFor(() => expect(pageTransition()).toHaveStyle({ visibility: "visible" }));
    expect(screen.getByText("Check the proxy")).toBeVisible();
    expect(screen.queryByText("Deploy a service")).not.toBeInTheDocument();
  });
});

describe("AIWorkspaceScenarioStart", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the start screen in place while a new page context refetches it", async () => {
    const nextScenarios = deferred<AIScenario[]>();
    vi.spyOn(api, "getAIScenarios")
      .mockResolvedValueOnce([scenario])
      .mockReturnValueOnce(nextScenarios.promise);
    vi.spyOn(api, "getFinalizeSetupState").mockResolvedValue(null);
    vi.spyOn(api, "getDashboardBootstrap").mockRejectedValue(new Error("offline"));
    const start = (route: string) => (
      <AIWorkspaceScenarioStart
        context={{ route }}
        disabled={false}
        onStart={vi.fn()}
        onInvestigateOperationalIssue={vi.fn()}
      />
    );

    const { rerender } = render(start("/"));
    expect(await screen.findByRole("button", { name: /Deploy a service/ })).toBeInTheDocument();

    rerender(start("/docker/containers"));
    expect(screen.getByRole("button", { name: /Deploy a service/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Show all scenarios/ })).toBeEnabled();

    await act(async () =>
      nextScenarios.resolve([{ ...scenario, id: "logs", title: "Read container logs" }])
    );
    expect(screen.getByRole("button", { name: /Read container logs/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Deploy a service/ })).not.toBeInTheDocument();
  });
});
