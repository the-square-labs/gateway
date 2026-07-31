import { useCommandPalettePageActions } from "./command-palette-page-actions";

describe("command palette page actions", () => {
  beforeEach(() => {
    useCommandPalettePageActions.setState({
      ownerToken: 0,
      registrations: {},
    });
  });

  it("keeps independent action registrations until their owners unmount", () => {
    const store = useCommandPalettePageActions.getState();
    const oldOwner = store.register("/docker", [
      { id: "refresh", label: "Refresh", action: vi.fn() },
    ]);
    const currentOwner = store.register("/nodes", [
      { id: "refresh", label: "Refresh nodes", action: vi.fn() },
    ]);

    useCommandPalettePageActions.getState().clear(oldOwner);
    expect(useCommandPalettePageActions.getState().registrations[currentOwner]?.routeKey).toBe(
      "/nodes"
    );

    useCommandPalettePageActions.getState().clear(currentOwner);
    expect(useCommandPalettePageActions.getState().registrations).toEqual({});
  });
});
