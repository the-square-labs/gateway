import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuthStore } from "@/stores/auth";
import { DEFAULT_SYSTEM_CONFIG, useSystemConfigStore } from "@/stores/system-config";
import { makeUser } from "@/test/fixtures";
import { renderWithRouter } from "@/test/render";
import { AccountMenuContent } from "./AccountMenuContent";

vi.mock("@/pages/inference/InferenceUsagePanels", () => ({
  CompactInferenceUsage: () => <section>Compact inference usage</section>,
}));

describe("AccountMenuContent", () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: makeUser({
        name: "Alex Gateway",
        email: "alex@example.com",
        scopes: ["inference:use", "inference:usage:view:self"],
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
  });

  it("shows account identity, scoped usage, and the existing actions", async () => {
    const user = userEvent.setup();
    const onLogout = vi.fn();
    const onNavigate = vi.fn();

    renderAccountMenu({ onLogout, onNavigate, showAdministration: true });

    expect(await screen.findByText("Alex Gateway")).toBeInTheDocument();
    expect(screen.getByText("alex@example.com")).toBeInTheDocument();
    expect(screen.getByText("Compact inference usage")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Administration" })).toBeInTheDocument();
    expect(screen.getByText("Alex Gateway")).toHaveClass("text-sm");
    expect(screen.getByText("alex@example.com")).toHaveClass("text-xs");
    expect(screen.getByRole("menuitem", { name: "Profile" })).not.toHaveClass("text-base");
    expect(
      screen
        .getAllByRole("separator")
        .every((separator) => separator.classList.contains("bg-border"))
    ).toBe(true);

    await user.click(screen.getByRole("menuitem", { name: "Profile" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/profile");
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("omits usage when the inference feature is disabled", async () => {
    useSystemConfigStore.setState({
      config: DEFAULT_SYSTEM_CONFIG,
      loaded: true,
      isLoading: false,
    });

    renderAccountMenu({ onLogout: vi.fn() });

    expect(await screen.findByText("Alex Gateway")).toBeInTheDocument();
    expect(screen.queryByText("Compact inference usage")).not.toBeInTheDocument();
  });
});

function renderAccountMenu(props: React.ComponentProps<typeof AccountMenuContent>) {
  return renderWithRouter(
    <>
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Account</DropdownMenuTrigger>
        <DropdownMenuContent forceMount>
          <AccountMenuContent {...props} />
        </DropdownMenuContent>
      </DropdownMenu>
      <LocationProbe />
    </>,
    { route: "/" }
  );
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}
