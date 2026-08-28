import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { vi } from "vitest";
import { Slider } from "./slider";

function SliderFixture() {
  const [value, setValue] = useState(1);
  return (
    <>
      <Slider value={value} min={1} max={3} step={0.1} ariaLabel="Zoom" onValueChange={setValue} />
      <output>{value}</output>
    </>
  );
}

describe("Slider", () => {
  it("renders the shared custom track, range, and thumb", () => {
    const { container } = render(<SliderFixture />);

    expect(screen.getByRole("slider", { name: "Zoom" })).toBeInTheDocument();
    expect(container.querySelector("[data-slider-track]")).toBeInTheDocument();
    expect(container.querySelector("[data-slider-range]")).toBeInTheDocument();
    expect(container.querySelector("[data-slider-thumb]")).toBeInTheDocument();
    expect(container.querySelector('input[type="range"]')).not.toBeInTheDocument();
  });

  it("supports keyboard and pointer changes", async () => {
    const user = userEvent.setup();
    render(<SliderFixture />);
    const slider = screen.getByRole("slider", { name: "Zoom" });

    await user.click(slider);
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("1.1")).toBeInTheDocument();
    await user.keyboard("{End}");
    expect(screen.getByText("3")).toBeInTheDocument();

    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 100,
      right: 100,
      top: 0,
      bottom: 20,
      height: 20,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const pointerDown = new MouseEvent("pointerdown", { bubbles: true, clientX: 50 });
    Object.defineProperty(pointerDown, "pointerId", { value: 1 });
    fireEvent(slider, pointerDown);
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});
