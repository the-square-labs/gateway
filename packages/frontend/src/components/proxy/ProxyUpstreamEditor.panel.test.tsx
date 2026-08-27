import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { api } from "@/services/api";
import type { ProxyHost } from "@/types";
import { ProxyUpstreamPanel } from "./ProxyUpstreamEditor";

function proxyHost(overrides: Partial<ProxyHost> = {}): ProxyHost {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "app",
    type: "proxy",
    domainNames: ["app.example.com"],
    enabled: true,
    maintenanceEnabled: false,
    maintenanceStartedAt: null,
    upstreamKind: "manual",
    forwardHost: "127.0.0.1",
    forwardPort: 8080,
    forwardScheme: "http",
    relaySpreadMode: "inherit",
    relaySpreadCount: null,
    sslEnabled: false,
    sslForced: false,
    http2Support: true,
    sslCertificateId: null,
    internalCertificateId: null,
    websocketSupport: false,
    redirectUrl: null,
    redirectStatusCode: 301,
    customHeaders: [],
    cacheEnabled: false,
    cacheOptions: null,
    rateLimitEnabled: false,
    rateLimitOptions: null,
    customRewrites: [],
    advancedConfig: null,
    rawConfig: null,
    rawConfigEnabled: false,
    accessListId: null,
    folderId: null,
    sortOrder: 0,
    nginxTemplateId: null,
    templateVariables: {},
    healthCheckEnabled: false,
    healthCheckUrl: "/",
    healthCheckInterval: 30,
    healthCheckExpectedStatus: null,
    healthCheckExpectedBody: null,
    healthCheckBodyMatchMode: "includes",
    healthCheckSlowThreshold: null,
    healthStatus: "unknown",
    lastHealthCheckAt: null,
    createdById: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("ProxyUpstreamPanel Relay spread", () => {
  it("keeps upstream IPv6 disabled by default and saves an explicit opt-in", async () => {
    const user = userEvent.setup();
    const host = proxyHost();
    vi.spyOn(api, "listDockerContainerSnapshots").mockResolvedValue([]);
    const update = vi
      .spyOn(api, "updateProxyHost")
      .mockResolvedValue(proxyHost({ upstreamIpv6Enabled: true }));

    render(<ProxyUpstreamPanel host={host} canManage onUpdated={vi.fn()} />);
    const toggle = screen.getByRole("button", { name: "Enable IPv6 support" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        host.id,
        expect.objectContaining({ upstreamIpv6Enabled: true })
      )
    );
  });

  it("preserves an unsaved draft across background host refreshes and marks the panel dirty", async () => {
    const user = userEvent.setup();
    const host = proxyHost();
    vi.spyOn(api, "listDockerContainerSnapshots").mockResolvedValue([]);

    const view = render(<ProxyUpstreamPanel host={host} canManage onUpdated={vi.fn()} />);
    await user.click(screen.getByRole("combobox", { name: "Workload relay spread mode" }));
    await user.click(screen.getByRole("option", { name: "Fixed count" }));

    expect(screen.getByText("Upstream").closest("div.border")).toHaveStyle({
      borderColor: "var(--color-warning)",
    });

    view.rerender(
      <ProxyUpstreamPanel
        host={proxyHost({ updatedAt: "2026-08-21T00:00:05.000Z" })}
        canManage
        onUpdated={vi.fn()}
      />
    );

    expect(screen.getByRole("combobox", { name: "Workload relay spread mode" })).toHaveTextContent(
      "Fixed count"
    );
    expect(screen.getByRole("spinbutton", { name: "Workload relay count" })).toHaveValue(2);
  });

  it("saves one workload-level override for all of its Secure Links", async () => {
    const user = userEvent.setup();
    const host = proxyHost();
    vi.spyOn(api, "listDockerContainerSnapshots").mockResolvedValue([]);
    const update = vi
      .spyOn(api, "updateProxyHost")
      .mockResolvedValue(proxyHost({ relaySpreadMode: "all" }));

    render(<ProxyUpstreamPanel host={host} canManage onUpdated={vi.fn()} />);
    await user.click(screen.getByRole("combobox", { name: "Workload relay spread mode" }));
    await user.click(screen.getByRole("option", { name: "All ready relays" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        host.id,
        expect.objectContaining({ relaySpreadMode: "all", relaySpreadCount: null })
      )
    );
  });
});
