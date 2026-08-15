import { render, screen, waitFor } from "@testing-library/react";
import { RefreshCw } from "lucide-react";
import { MemoryRouter } from "react-router-dom";
import { useCommandPalettePageActions } from "@/stores/command-palette-page-actions";
import {
  getHeaderActionOverflowCount,
  HeaderOverflowMenu,
  ResponsiveHeaderActions,
  shouldCollapseHeaderActions,
} from "./ResponsiveHeaderActions";

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

  it("collapses actions when the header cannot preserve title space", () => {
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const width =
          this.dataset.testid === "header"
            ? 900
            : this.hasAttribute("data-header-overflow-measure")
              ? 40
              : this.hasAttribute("data-header-action-item")
                ? 640
                : 0;
        return {
          width,
          height: 0,
          top: 0,
          right: width,
          bottom: 0,
          left: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      });

    render(
      <MemoryRouter initialEntries={["/docker"]}>
        <div data-testid="header">
          <div>Docker</div>
          <ResponsiveHeaderActions actions={[{ label: "Deploy", onClick: vi.fn() }]}>
            <button type="button">Deploy</button>
          </ResponsiveHeaderActions>
        </div>
      </MemoryRouter>
    );

    expect(screen.getByRole("button", { name: "Page actions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deploy" })).not.toBeInTheDocument();
    rectSpy.mockRestore();
  });

  it("moves only the required leftmost actions into overflow", () => {
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const width =
          this.dataset.testid === "header"
            ? 650
            : this.hasAttribute("data-header-overflow-measure")
              ? 40
              : this.hasAttribute("data-header-action-item")
                ? 120
                : 0;
        return {
          width,
          height: 0,
          top: 0,
          right: width,
          bottom: 0,
          left: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      });

    render(
      <MemoryRouter initialEntries={["/docker"]}>
        <div data-testid="header">
          <div>Docker</div>
          <ResponsiveHeaderActions
            actions={[
              { label: "Refresh", onClick: vi.fn() },
              { label: "New Folder", onClick: vi.fn() },
              { label: "Deploy", onClick: vi.fn() },
            ]}
          >
            <button type="button">Refresh</button>
            <button type="button">New Folder</button>
            <button type="button">Deploy</button>
          </ResponsiveHeaderActions>
        </div>
      </MemoryRouter>
    );

    expect(screen.getByRole("button", { name: "Page actions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Folder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deploy" })).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label") ?? button.textContent)
    ).toEqual(["New Folder", "Deploy", "Page actions"]);
    rectSpy.mockRestore();
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

describe("shouldCollapseHeaderActions", () => {
  it("keeps room for the page title before showing all actions", () => {
    expect(shouldCollapseHeaderActions(900, 640)).toBe(true);
    expect(shouldCollapseHeaderActions(1_100, 640)).toBe(false);
  });

  it("does not collapse while the header has no measurable layout", () => {
    expect(shouldCollapseHeaderActions(0, 640)).toBe(false);
    expect(shouldCollapseHeaderActions(1_000, 0)).toBe(false);
  });

  it("supports pages with compact header content", () => {
    expect(shouldCollapseHeaderActions(820, 640, 160)).toBe(false);
    expect(shouldCollapseHeaderActions(780, 640, 160)).toBe(true);
  });
});

describe("getHeaderActionOverflowCount", () => {
  it("progressively overflows actions from left to right", () => {
    const widths = [120, 120, 120];

    expect(getHeaderActionOverflowCount(760, widths, 40, 320, 8)).toBe(0);
    expect(getHeaderActionOverflowCount(650, widths, 40, 320, 8)).toBe(1);
    expect(getHeaderActionOverflowCount(520, widths, 40, 320, 8)).toBe(2);
    expect(getHeaderActionOverflowCount(350, widths, 40, 320, 8)).toBe(3);
  });

  it("waits for measurable action and overflow widths", () => {
    expect(getHeaderActionOverflowCount(650, [], 40)).toBe(0);
    expect(getHeaderActionOverflowCount(650, [120], 0)).toBe(0);
    expect(getHeaderActionOverflowCount(650, [0], 40)).toBe(0);
  });
});
