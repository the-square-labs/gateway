import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_CTA_URL, useDemoModeStore } from "@/stores/demo-mode";
import { DemoModeDialog } from "./DemoModeDialog";

afterEach(() => {
  cleanup();
  useDemoModeStore.setState({ enabled: false, open: false });
});

describe("DemoModeDialog", () => {
  it("uses the standard dialog and a fixed safe CTA", () => {
    useDemoModeStore.setState({ enabled: true, open: true });
    render(<DemoModeDialog />);

    expect(
      screen.getByRole("heading", { name: "This action is unavailable in the demo" })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Get your own Gateway" })).toHaveAttribute(
      "href",
      DEMO_CTA_URL
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[1]);
    expect(useDemoModeStore.getState().open).toBe(false);
  });
});
