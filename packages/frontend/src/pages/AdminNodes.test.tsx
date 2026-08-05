import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { AdminNodes } from "@/pages/AdminNodes";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeNode, makeUser } from "@/test/fixtures";
import { renderWithRouter } from "@/test/render";

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: vi.fn(),
}));

describe("AdminNodes", () => {
  it("creates a node and shows the enrollment token and setup command", async () => {
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 50,
      totalPages: 0,
    });
    vi.spyOn(api, "listNodeFolders").mockResolvedValue([]);
    vi.spyOn(api, "getDaemonUpdates").mockResolvedValue([]);
    const createNodeSpy = vi.spyOn(api, "createNode").mockResolvedValue({
      node: makeNode({ id: "node-2", status: "pending", type: "nginx" }),
      enrollmentToken: "token-123",
      gatewayCertSha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    useAuthStore.setState({
      user: makeUser({ scopes: ["nodes:details", "nodes:create"] }),
      isAuthenticated: true,
      isLoading: false,
    });

    renderWithRouter(<AdminNodes />);

    await waitFor(() => {
      expect(api.listNodes).toHaveBeenCalled();
    });

    const user = userEvent.setup();
    const addNodeButton = screen.getAllByRole("button", { name: /add node/i })[0];
    if (!addNodeButton) throw new Error("Primary Add Node button not found");
    await user.click(addNodeButton);
    await user.type(screen.getByPlaceholderText("US-East Proxy"), "Branch Edge");
    await user.click(screen.getByRole("button", { name: /create node/i }));

    expect(createNodeSpy).toHaveBeenCalledWith({
      type: "nginx",
      hostname: "pending",
      displayName: "Branch Edge",
    });

    expect(await screen.findByText("Node Created")).toBeInTheDocument();
    expect(screen.getByText(/single-use/i)).toBeInTheDocument();
    expect(screen.getByText("token-123")).toBeInTheDocument();
    expect(screen.getByText(/setup-node\.sh/)).not.toHaveTextContent("--type");
    expect(screen.getByText(/setup-node\.sh/)).toHaveTextContent("--token token-123");
    expect(screen.getByText(/setup-node\.sh/)).toHaveTextContent(
      "--gateway-cert-sha256 sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
  });
});
