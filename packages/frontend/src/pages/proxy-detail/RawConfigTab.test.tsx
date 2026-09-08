import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
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
  expect(screen.queryByLabelText("Loading rendered config")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
  rerender(<RawConfigTab {...props} renderedConfig="server { listen 80; }" />);
  expect(screen.getByTestId("editor")).toBe(editor);
  expect(editor.scrollTop).toBe(170);
});
it("uses a skeleton only before the first rendered document has loaded", () => {
  const { rerender } = render(
    <RawConfigTab {...props} renderedConfig="" hasLoadedRendered={false} isLoadingRaw />
  );
  expect(screen.getByLabelText("Loading rendered config")).toBeInTheDocument();
  rerender(<RawConfigTab {...props} renderedConfig="" hasLoadedRendered isLoadingRaw />);
  expect(screen.getByTestId("editor")).toBeInTheDocument();
});
