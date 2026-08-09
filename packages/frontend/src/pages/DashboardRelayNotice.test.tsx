import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import type { DashboardRelaySnapshot } from "@/types";
import { RelayHealthNotice } from "./Dashboard";

const critical: DashboardRelaySnapshot = {
  state: "critical",
  impact: "Managed nodes and secure database connections are disconnected.",
  attempt: 3,
  maxAttempts: 3,
  lastHealthyAt: null,
  reason: "unreachable",
  lastProbeAt: "2026-08-07T12:00:00.000Z",
  attemptHistory: [
    { attempt: 3, startedAt: "2026-08-07T11:59:00.000Z", action: "restart", result: "failed" },
  ],
  relayBuildVersion: "1",
  protocolMajor: 1,
  expectedService: "relay",
  expectedImage: `registry.example/gateway@sha256:${"a".repeat(64)}`,
  canRetry: true,
};

describe("RelayHealthNotice", () => {
  it("shows generic critical impact without admin diagnostics", () => {
    render(
      <RelayHealthNotice relay={critical} isAdmin={false} retryPending={false} onRetry={vi.fn()} />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Gateway relay is unavailable");
    expect(screen.queryByText("Contact your administrator.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(
      screen.getByText(
        "Please contact your administrator to restore managed nodes and secure database connections."
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(/Reason:/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry recovery" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveClass("sm:max-w-md");
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[1]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows bounded admin diagnostics and invokes manual retry", () => {
    const onRetry = vi.fn();
    render(<RelayHealthNotice relay={critical} isAdmin retryPending={false} onRetry={onRetry} />);

    expect(screen.queryByText("unreachable")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(screen.getByRole("table")).toHaveClass("table-fixed");
    expect(
      screen.getByText("Automatic recovery failed. Immediate administrator action is required.")
    ).toHaveAttribute("data-dialog-description");
    expect(
      screen
        .getByText("Automatic recovery failed. Immediate administrator action is required.")
        .closest("[data-dialog-body]")
    ).not.toBeNull();
    expect(screen.getByText("Reason").nextElementSibling).toHaveTextContent("unreachable");
    expect(screen.getByText("Attempts").nextElementSibling).toHaveTextContent("#3 restart failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry recovery" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("uses the agreed non-critical recovery copy and disables actions", () => {
    render(
      <RelayHealthNotice
        relay={{ ...critical, state: "recovering", attempt: 2, canRetry: false }}
        isAdmin
        retryPending={false}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("Gateway relay recovery in progress");
    expect(screen.getByRole("status")).toHaveTextContent("Recovery attempt 2 of 3 is in progress");
    expect(screen.queryByRole("button", { name: "Retry recovery" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View details" })).toBeInTheDocument();
  });

  it("renders nothing for healthy state", () => {
    const { container } = render(
      <RelayHealthNotice
        relay={{ ...critical, state: "healthy" }}
        isAdmin
        retryPending={false}
        onRetry={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
