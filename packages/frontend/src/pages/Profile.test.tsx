import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { DEFAULT_SYSTEM_CONFIG, useSystemConfigStore } from "@/stores/system-config";
import { makeUser } from "@/test/fixtures";
import { Profile } from "./Profile";

vi.mock("@/pages/inference/InferenceUsagePanels", () => ({
  InferenceUsage: () => <section>Inference usage panel</section>,
}));
vi.mock("@/pages/inference/InferenceTokensSection", () => ({
  InferenceTokensSection: () => <section>Inference token authorizations</section>,
}));
vi.mock("@/pages/settings/ApiTokensSection", () => ({
  ApiTokensSection: () => <section>Gateway API authorizations</section>,
}));
vi.mock("@/pages/settings/OAuthApplicationsSection", () => ({
  OAuthApplicationsSection: () => <section>OAuth authorizations</section>,
}));

describe("Profile", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAuthStore.setState({
      user: makeUser({
        name: "Alex Gateway",
        email: "alex@example.com",
        scopes: [
          "inference:use",
          "inference:usage:view:self",
          "inference:tokens:create",
          "inference:tokens:revoke",
        ],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
    useSystemConfigStore.setState({
      config: {
        ...DEFAULT_SYSTEM_CONFIG,
        features: { ...DEFAULT_SYSTEM_CONFIG.features, inferenceEnabled: true },
      },
      loaded: true,
      isLoading: false,
    });
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 100,
      totalPages: 0,
    });
    vi.spyOn(api, "listProxyHosts").mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 100, total: 0, totalPages: 0 },
    });
    vi.spyOn(api, "listDatabases").mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 200, total: 0, totalPages: 0 },
    });
  });

  it("keeps personal preferences and inference limits on the Preferences tab", () => {
    renderProfile("/profile");

    expect(screen.getByRole("heading", { name: "Profile", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("Alex Gateway")).toBeInTheDocument();
    expect(screen.getByText("Inference usage panel")).toBeInTheDocument();
    expect(screen.queryByText("Gateway API authorizations")).not.toBeInTheDocument();
  });

  it("groups API, OAuth, and inference credentials on the Authorizations tab", async () => {
    const user = userEvent.setup();
    renderProfile("/profile/authorizations");

    expect(screen.getByText("Gateway API authorizations")).toBeInTheDocument();
    expect(screen.getByText("OAuth authorizations")).toBeInTheDocument();
    expect(screen.getByText("Inference token authorizations")).toBeInTheDocument();
    expect(screen.queryByText("Inference usage panel")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Preferences" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/profile");
  });

  it("returns unknown profile tabs to Preferences", async () => {
    renderProfile("/profile/unknown");

    expect(await screen.findByTestId("location")).toHaveTextContent("/profile");
    expect(screen.getByRole("tab", { name: "Preferences" })).toHaveAttribute(
      "data-state",
      "active"
    );
  });
});

function renderProfile(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route
          path="/profile/:tab?"
          element={
            <>
              <Profile />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}
