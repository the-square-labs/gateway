import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useLicensePaywallStore } from "@/stores/license-paywall";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { PageProfile } from "@/types";
import { PagesSettingsSection } from "./PageGlobalSettings";

const profile: PageProfile = {
  id: "default",
  enabled: true,
  status: "ready",
  domainId: "11111111-1111-4111-8111-111111111111",
  nodeId: null,
  certificateId: "22222222-2222-4222-8222-222222222222",
  labelTemplate: "{hash}",
  overrideSameRegistrableDomain: false,
  overrideAcknowledgedById: null,
  overrideAcknowledgedAt: null,
  domain: {
    id: "11111111-1111-4111-8111-111111111111",
    domain: "*.pages.example.com",
    dnsStatus: "valid",
    nginxNodeId: null,
  },
  node: null,
  certificate: {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Pages wildcard",
    domainNames: ["*.pages.example.com"],
    status: "active",
    notAfter: null,
  },
  isolation: {
    gatewayHost: "gateway.example.net",
    pagesHost: "pages.example.com",
    gatewayRegistrableDomain: "example.net",
    pagesRegistrableDomain: "example.com",
    same: false,
    overrideRequired: false,
    overrideCurrent: false,
  },
};

describe("PagesSettingsSection", () => {
  beforeEach(() => {
    useLicensePaywallStore.setState({ request: null });
    useAuthStore.setState({
      user: { id: "user-1", scopes: ["pages:settings:edit"], isBlocked: false } as never,
      isAuthenticated: true,
      isLoading: false,
    });
    useUIBootstrapStore.setState({
      snapshot: { license: { plan: "personal", entitlements: { features: ["pages"] } } } as never,
    });
    vi.spyOn(api, "getPageProfile").mockResolvedValue(profile);
    vi.spyOn(api, "getPageProfileOptions").mockResolvedValue({
      domains: [
        {
          id: profile.domainId!,
          domain: profile.domain!.domain,
          dnsStatus: "valid",
          nginxNodeId: null,
          isolation: {
            gatewayHost: "gateway.example.net",
            pagesHost: "pages.example.com",
            gatewayRegistrableDomain: "example.net",
            pagesRegistrableDomain: "example.com",
            same: false,
          },
        },
      ],
      nodes: [],
      certificates: [profile.certificate!],
    });
  });

  it("lets Community users edit settings but opens the Personal paywall on save", async () => {
    const user = userEvent.setup();
    const update = vi.spyOn(api, "updatePageProfile").mockResolvedValue(profile);
    useUIBootstrapStore.setState({
      snapshot: { license: { plan: "community", entitlements: { features: [] } } } as never,
    });

    render(
      <MemoryRouter>
        <PagesSettingsSection />
      </MemoryRouter>
    );

    expect(await screen.findByText("Personal+")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Enable Pages" })).toBeEnabled();
    expect(screen.getByRole("textbox")).toBeEnabled();
    for (const control of screen.getAllByRole("combobox")) {
      expect(control).toBeEnabled();
    }
    expect(api.getPageProfile).toHaveBeenCalledOnce();
    expect(api.getPageProfileOptions).toHaveBeenCalledOnce();

    await user.type(screen.getByRole("textbox"), "-preview");
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    expect(useLicensePaywallStore.getState().request).toMatchObject({
      capability: "Pages",
      requiredPlan: "personal",
      currentPlan: "community",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("uses a dirty toggle and disables Save until the preview setting changes", async () => {
    const user = userEvent.setup();
    const update = vi
      .spyOn(api, "updatePageProfile")
      .mockResolvedValue({ ...profile, enabled: false, status: "disabled" });

    render(
      <MemoryRouter>
        <PagesSettingsSection />
      </MemoryRouter>
    );

    const save = await screen.findByRole("button", { name: "Save profile" });
    const toggle = screen.getByRole("button", { name: "Enable Pages" });
    const panel = screen.getByText("Pages").closest("div.border") as HTMLElement;

    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(save).toBeDisabled();

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(save).toBeEnabled();
    expect(panel).toHaveStyle({ borderColor: "var(--color-warning)" });

    await user.click(save);

    await waitFor(() => expect(update).toHaveBeenCalledWith({ enabled: false }));
    expect(save).toBeDisabled();
  });

  it("marks an invalid hostname template on the input without rendering custom error copy", async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <PagesSettingsSection />
      </MemoryRouter>
    );

    const input = await screen.findByDisplayValue("{hash}");
    await user.clear(input);
    await user.type(input, "{hash}.bad");

    expect(input).toHaveClass("border-destructive");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText(/Template must|Rendered template/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
  });
});
