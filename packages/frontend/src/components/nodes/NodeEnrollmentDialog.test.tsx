import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { api } from "@/services/api";
import { makeNode } from "@/test/fixtures";
import { NodeEnrollmentDialog } from "./NodeEnrollmentDialog";

let realtimeHandler: ((payload: unknown) => void) | undefined;

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: vi.fn((_channel: string | null, handler: (payload: unknown) => void) => {
    realtimeHandler = handler;
  }),
}));

describe("NodeEnrollmentDialog", () => {
  it("uses the standard locked Relay enrollment flow and closes after that node connects", async () => {
    const user = userEvent.setup();
    const pendingNode = makeNode({ id: "relay-node-1", type: "relay", status: "pending" });
    vi.spyOn(api, "createNode").mockResolvedValue({
      node: pendingNode,
      enrollmentToken: "relay-token",
      gatewayCertSha256: `sha256:${"a".repeat(64)}`,
      gatewayEnrollmentTargets: {
        public: { label: "Public node", gateway: "gateway.example.com:9443" },
      },
    });
    vi.spyOn(api, "getNode").mockResolvedValue({
      ...pendingNode,
      lastHealthReport: null,
      lastStatsReport: null,
      liveHealthReport: null,
      liveStatsReport: null,
    });
    const onNodeEnrolled = vi.fn();

    render(
      <NodeEnrollmentDialog
        open
        onOpenChange={vi.fn()}
        initialType="relay"
        lockType
        onNodeEnrolled={onNodeEnrolled}
      />
    );

    const typeSelector = screen.getByRole("combobox", { name: "Node Type" });
    expect(typeSelector).toBeDisabled();
    expect(
      screen.getByText("Adds a physical host to the Secure Link Relay Pool.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Bastion")).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("EU Relay"), "EU Relay 1");
    await user.type(screen.getByPlaceholderText("relay.example.com"), "relay-1.example.com");
    await user.click(screen.getByRole("button", { name: "Create Node" }));

    expect(api.createNode).toHaveBeenCalledWith({
      type: "relay",
      hostname: "pending",
      displayName: "EU Relay 1",
      serviceAddresses: ["relay-1.example.com"],
      servicePort: 9443,
    });
    expect(await screen.findByText("Node Created")).toBeInTheDocument();
    const command = screen.getByText(/setup-relay-node\.sh/);
    expect(command).toHaveTextContent("--advertise-address relay-1.example.com");

    act(() => realtimeHandler?.({ id: "relay-node-1", status: "online" }));

    await waitFor(() => expect(screen.queryByText("Node Created")).not.toBeInTheDocument());
    expect(onNodeEnrolled).toHaveBeenCalledWith("relay-node-1");
  });
});
