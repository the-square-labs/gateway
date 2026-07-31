import { render, screen, waitFor } from "@testing-library/react";
import { RefreshCw } from "lucide-react";
import { MemoryRouter } from "react-router-dom";
import { useCommandPalettePageActions } from "@/stores/command-palette-page-actions";
import { HeaderOverflowMenu, ResponsiveHeaderActions } from "./ResponsiveHeaderActions";

describe("ResponsiveHeaderActions command palette registration", () => {
  beforeEach(() => {
    useCommandPalettePageActions.setState({ ownerToken: 0, registrations: {} });
  });

  it("registers the page header actions for Quick actions", async () => {
    const refresh = vi.fn();
    render(
      <MemoryRouter initialEntries={["/nodes"]}>
        <ResponsiveHeaderActions
          actions={[
            {
              label: "Refresh nodes",
              icon: <RefreshCw className="h-4 w-4" />,
              onClick: refresh,
            },
          ]}
        >
          <button type="button" onClick={refresh}>
            Refresh nodes
          </button>
        </ResponsiveHeaderActions>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(Object.values(useCommandPalettePageActions.getState().registrations)).toEqual([
        expect.objectContaining({
          routeKey: "/nodes",
          actions: [
            expect.objectContaining({
              label: "Refresh nodes",
              action: refresh,
            }),
          ],
        }),
      ]);
    });
  });
});

describe("HeaderOverflowMenu", () => {
  it("does not render the overflow trigger when no actions are available", () => {
    render(<HeaderOverflowMenu actions={[]} />);

    expect(screen.queryByRole("button", { name: "More page actions" })).not.toBeInTheDocument();
  });

  it("renders the overflow trigger when at least one action is available", () => {
    render(
      <HeaderOverflowMenu actions={[{ label: "Remove", onClick: vi.fn(), destructive: true }]} />
    );

    expect(screen.getByRole("button", { name: "More page actions" })).toBeInTheDocument();
  });
});
