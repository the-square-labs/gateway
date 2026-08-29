import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { InferenceEndpointRow, InferenceHarnessDialog } from "./InferenceEndpointSettingsPanel";

describe("Inference endpoint controls", () => {
  it("shows the stable base URL and explains Codex and Claude Code setup", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderWithRouter(
      <>
        <InferenceEndpointRow />
        <InferenceHarnessDialog open onOpenChange={onOpenChange} />
      </>
    );

    expect(screen.getByText(/\/api\/inference\/v1/)).toBeInTheDocument();

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("npx -y @sqgateway/inference@latest")).toBeInTheDocument();
    expect(screen.getByText("npx -y @sqgateway/inference@latest setup codex")).toBeInTheDocument();
    expect(
      screen.getByText("npx -y @sqgateway/inference@latest setup claude-code")
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/--url/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ login http:\/\/localhost/)).not.toBeInTheDocument();
    expect(screen.getByText("Codex Desktop requires extra setup")).toBeInTheDocument();
    expect(screen.getByText(/Sign in to an OpenAI account/)).toBeInTheDocument();
    expect(screen.getByText("Claude Code CLI only")).toBeInTheDocument();
    expect(screen.getByText(/Claude Code 2.1.129 or newer/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy Direct Codex setup" }));
    expect(writeText).toHaveBeenCalledWith(
      "npx -y @sqgateway/inference@latest setup codex --url http://localhost:3000"
    );

    const closeButtons = within(dialog).getAllByRole("button", { name: "Close" });
    await user.click(closeButtons.at(-1)!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
