import { getDefaultAIPanelWidth, isCompactPanelsViewport } from "./responsive-panels";

describe("responsive panels", () => {
  it.each([
    [800, 360],
    [1024, 410],
    [1100, 410],
    [1440, 410],
  ])("uses a %ipx AI panel at a %ipx viewport", (viewportWidth, expectedWidth) => {
    expect(getDefaultAIPanelWidth(viewportWidth)).toBe(expectedWidth);
  });

  it("uses the compact layout breakpoint for mutually exclusive panels", () => {
    expect(isCompactPanelsViewport(899)).toBe(true);
    expect(isCompactPanelsViewport(900)).toBe(false);
  });
});
