import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AIProviderControls, shouldCompactProviderControls } from "./AIProviderControls";

const modelOptions = [
  {
    id: "model-a",
    displayName: "Model A",
    supportsImages: false,
    maxContextTokens: 1000,
    maxOutputTokens: null,
    reasoningEfforts: ["high", "max"],
    defaultReasoningEffort: "high",
  },
  {
    id: "model-b",
    displayName: "Model B",
    supportsImages: false,
    maxContextTokens: 1000,
    maxOutputTokens: null,
    reasoningEfforts: ["high", "max"],
    defaultReasoningEffort: "high",
  },
];

function rect(width: number): DOMRect {
  return {
    bottom: 0,
    height: 0,
    left: 0,
    right: width,
    top: 0,
    width,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  };
}

function mockControlWidths(availableWidth: number, controlsWidth: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.getAttribute("aria-hidden") === "true") return rect(controlsWidth);
    if (this.classList.contains("relative") && this.classList.contains("flex-1")) {
      return rect(availableWidth);
    }
    return rect(0);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AIProviderControls", () => {
  it("keeps the separate controls when they fit with the width reserve", () => {
    mockControlWidths(320, 260);

    render(
      <AIProviderControls
        modelOptions={modelOptions}
        selectedModel="model-a"
        onModelChange={vi.fn()}
        reasoningOptions={["high", "max"]}
        selectedReasoningEffort="high"
        onReasoningEffortChange={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "AI model" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reasoning effort" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Model and reasoning settings" })
    ).not.toBeInTheDocument();
  });

  it("uses nested model and reasoning menus when the separate controls do not fit", async () => {
    const user = userEvent.setup();
    const onModelChange = vi.fn();
    const onReasoningEffortChange = vi.fn();
    mockControlWidths(260, 240);

    render(
      <AIProviderControls
        modelOptions={modelOptions}
        selectedModel="model-a"
        onModelChange={onModelChange}
        reasoningOptions={["high", "max"]}
        selectedReasoningEffort="high"
        onReasoningEffortChange={onReasoningEffortChange}
      />
    );

    const settings = await screen.findByRole("button", {
      name: "Model and reasoning settings",
    });
    expect(screen.queryByRole("button", { name: "AI model" })).not.toBeInTheDocument();

    await user.click(settings);
    const menu = screen.getByRole("menu");
    const modelValue = within(menu).getByText("Model A");
    const reasoningValue = within(menu).getByText("high");
    expect(modelValue).toHaveClass(
      "ml-auto",
      "min-w-0",
      "max-w-28",
      "truncate",
      "text-sm",
      "text-right"
    );
    expect(reasoningValue).toHaveClass(
      "ml-auto",
      "min-w-0",
      "max-w-24",
      "truncate",
      "text-sm",
      "text-right"
    );
    expect(modelValue.closest('[role="menuitem"]')).toHaveClass("[&>svg:last-child]:ml-0");
    expect(reasoningValue.closest('[role="menuitem"]')).toHaveClass("[&>svg:last-child]:ml-0");

    await user.hover(screen.getByText("Model"));
    fireEvent.click(await screen.findByText("Model B"));
    await waitFor(() => expect(onModelChange).toHaveBeenCalledWith("model-b"));

    await user.click(settings);
    await user.hover(screen.getByText("Reasoning"));
    fireEvent.click(await screen.findByText("max"));
    await waitFor(() => expect(onReasoningEffortChange).toHaveBeenCalledWith("max"));
  });
});

describe("shouldCompactProviderControls", () => {
  it("keeps a 32px reserve before showing separate controls", () => {
    expect(shouldCompactProviderControls(272, 240)).toBe(false);
    expect(shouldCompactProviderControls(271, 240)).toBe(true);
  });
});
