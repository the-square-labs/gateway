import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INFERENCE_SELF_USAGE_UPDATED_EVENT } from "@/lib/inference-self-usage";
import { api } from "@/services/api";
import { useAIStore } from "@/stores/ai";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import { renderWithRouter } from "@/test/render";
import { CommandPalette } from "./CommandPalette";

describe("CommandPalette inference quota", () => {
  beforeEach(() => {
    vi.spyOn(api, "listNodes").mockResolvedValue({ data: [] } as never);
    vi.spyOn(api, "listProxyHosts").mockResolvedValue({ data: [] } as never);
    useDockerStore.setState({ containers: [] });
  });

  it("disables Ask AI when Gateway Inference quota is exhausted", async () => {
    const exhaustedUsage = {
      enabled: true,
      api: { configured: false, percentage: 0, recoveryAt: "2030-01-01T00:00:00.000Z" },
      subscription: {
        "5h": { configured: false, percentage: 0, recoveryAt: "2030-01-01T00:00:00.000Z" },
        "7d": { configured: true, percentage: 99.6, recoveryAt: "2030-01-07T00:00:00.000Z" },
        "30d": {
          configured: false,
          percentage: 0,
          recoveryAt: "2030-01-30T00:00:00.000Z",
        },
      },
    };
    vi.spyOn(api, "getInferenceSelfUsage").mockImplementation(async () => {
      window.dispatchEvent(
        new CustomEvent(INFERENCE_SELF_USAGE_UPDATED_EVENT, { detail: exhaustedUsage })
      );
      return exhaustedUsage;
    });
    const sendMessage = vi.fn();

    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          groupName: "admin",
          scopes: ["feat:ai:use", "inference:usage:view:self"],
          isBlocked: false,
        } as never,
        isAuthenticated: true,
        isLoading: false,
      });
      useAIStore.setState({
        isEnabled: true,
        isConnected: true,
        isStreaming: false,
        providerStatus: {
          enabled: true,
          providerType: "gateway_inference",
          defaultModel: "k3",
          allowUserModelSelection: false,
          supportsImages: false,
          models: [],
        },
        sendMessage,
      });
    });

    renderWithRouter(<CommandPalette open onOpenChange={vi.fn()} />);
    await userEvent.type(
      screen.getByPlaceholderText("Search or type > for commands..."),
      "start container"
    );

    const askAI = await screen.findByRole("option", { name: /Ask AI: "start container"/ });
    expect(askAI).toHaveAttribute("data-disabled", "true");
    expect(askAI).toHaveTextContent("Quota exhausted");

    await userEvent.click(askAI);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keeps the search visible until the close animation finishes", async () => {
    renderWithRouter(<CommandPalette open onOpenChange={vi.fn()} />);
    const input = screen.getByPlaceholderText("Search or type > for commands...");
    await userEvent.type(input, "start container");

    const dialog = screen.getByRole("dialog");
    fireEvent.animationEnd(dialog);
    expect(input).toHaveValue("start container");

    dialog.setAttribute("data-state", "closed");
    fireEvent.animationEnd(dialog);
    expect(input).toHaveValue("");
  });
});
