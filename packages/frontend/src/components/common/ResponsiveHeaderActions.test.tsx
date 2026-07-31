import { render, waitFor } from "@testing-library/react";
import { RefreshCw } from "lucide-react";
import { MemoryRouter } from "react-router-dom";
import { useCommandPalettePageActions } from "@/stores/command-palette-page-actions";
import { ResponsiveHeaderActions } from "./ResponsiveHeaderActions";

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
