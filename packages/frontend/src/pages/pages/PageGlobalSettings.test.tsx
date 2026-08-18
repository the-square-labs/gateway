import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
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
    useAuthStore.setState({
      user: { id: "user-1", scopes: ["pages:settings:edit"], isBlocked: false } as never,
      isAuthenticated: true,
      isLoading: false,
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
    const toggle = screen.getByRole("button", { name: "Enable immutable previews" });
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
