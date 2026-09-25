import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PageTransition } from "@/components/common/PageTransition";
import { waitForReveal } from "@/test/reveal";
import { RawConfigTab, type RawConfigTabProps } from "./RawConfigTab";

vi.mock("@/components/ui/code-editor", () => ({
  CodeEditor: ({ value }: { value: string }) => <div data-testid="editor">{value}</div>,
}));
const props: RawConfigTabProps = {
  isRawMode: false,
  rawConfig: "",
  setRawConfig: vi.fn(),
  renderedConfig: "server { }",
  hasLoadedRendered: true,
  isLoadingRaw: false,
  isSavingRaw: false,
  editorErrorLines: [],
  setEditorErrorLines: vi.fn(),
  onValidate: async () => true,
  onSaveRaw: vi.fn(),
  onRefreshRendered: vi.fn(),
  dirty: false,
  canManage: true,
};
it("retains the rendered editor DOM and scroll during background refresh", () => {
  const { rerender } = render(<RawConfigTab {...props} />);
  const editor = screen.getByTestId("editor");
  editor.scrollTop = 170;
  rerender(<RawConfigTab {...props} isLoadingRaw />);
  expect(screen.getByTestId("editor")).toBe(editor);
  expect(editor.scrollTop).toBe(170);
  expect(editor).toBeVisible();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
  rerender(<RawConfigTab {...props} renderedConfig="server { listen 80; }" />);
  expect(screen.getByTestId("editor")).toBe(editor);
  expect(editor.scrollTop).toBe(170);
});
it("keeps the tab hidden only until the first rendered document has loaded", async () => {
  const { rerender } = render(
    <PageTransition>
      <RawConfigTab {...props} renderedConfig="" hasLoadedRendered={false} isLoadingRaw />
    </PageTransition>
  );
  const gate = document.querySelector("[data-reveal-phase]");
  expect(gate).not.toHaveAttribute("data-reveal-phase", "revealed");
  expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
  rerender(
    <PageTransition>
      <RawConfigTab {...props} renderedConfig="" hasLoadedRendered isLoadingRaw />
    </PageTransition>
  );
  await waitForReveal();
  expect(screen.getByTestId("editor")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
});
