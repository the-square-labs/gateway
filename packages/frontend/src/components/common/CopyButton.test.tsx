import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "./CopyButton";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

describe("CopyButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  });

  it("uses the legacy copy command when the page is served over HTTP", async () => {
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

    render(<CopyButton value="ARX8-CB2GG" label="authorization code" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy authorization code" }));

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(document.querySelector("textarea")).not.toBeInTheDocument();
  });

  it("falls back to the legacy command when Clipboard API rejects a secure-context write", async () => {
    const execCommand = vi.fn().mockReturnValue(true);
    const writeText = vi.fn().mockRejectedValue(new Error("Permission denied"));
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

    render(<CopyButton value="ARX8-CB2GG" label="authorization code" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy authorization code" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ARX8-CB2GG"));
    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
  });
});
