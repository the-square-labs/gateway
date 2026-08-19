import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "@/test/render";
import { InferenceEndpointSettingsPanel } from "./InferenceEndpointSettingsPanel";

describe("InferenceEndpointSettingsPanel", () => {
  it("shows the stable base URL and explains Codex and Claude Code setup", async () => {
    const user = userEvent.setup();

    renderWithRouter(<InferenceEndpointSettingsPanel />);

    expect(screen.getByText("Inference endpoints")).toBeInTheDocument();
    expect(screen.getByText(/\/api\/inference\/v1/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Set up a harness" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("npx -y @wiolett/gateway-inference@latest")).toBeInTheDocument();
    expect(screen.getByText(/setup codex/)).toBeInTheDocument();
    expect(screen.getByText(/setup claude-code/)).toBeInTheDocument();
    expect(screen.getByText("Codex Desktop requires extra setup")).toBeInTheDocument();
    expect(screen.getByText(/Sign in to an OpenAI account/)).toBeInTheDocument();
    expect(screen.getByText("Claude Code CLI only")).toBeInTheDocument();
    expect(screen.getByText(/Claude Code 2.1.129 or newer/)).toBeInTheDocument();

    const closeButtons = within(dialog).getAllByRole("button", { name: "Close" });
    await user.click(closeButtons.at(-1)!);
  });
});
