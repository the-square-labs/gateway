import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { AdvancedTab } from "./AdvancedTab";
import { RawConfigTab } from "./RawConfigTab";

vi.mock("@/components/ui/code-editor", () => ({
  CodeEditor: () => <div data-testid="code-editor" />,
}));

describe("route config panel dirty state", () => {
  it("marks Advanced Config with the shared warning border", () => {
    render(
      <AdvancedTab
        advancedConfig=""
        setAdvancedConfig={vi.fn()}
        editorErrorLines={[]}
        setEditorErrorLines={vi.fn()}
        onValidate={vi.fn().mockResolvedValue(true)}
        onSaveAdvanced={vi.fn()}
        isSavingAdvanced={false}
        dirty
        canManage
      />
    );

    expect(screen.getByText("Advanced Config").closest("div.border")).toHaveStyle({
      borderColor: "var(--color-warning)",
    });
  });

  it("marks editable Raw Config with the shared warning border", () => {
    render(
      <RawConfigTab
        isRawMode
        rawConfig=""
        setRawConfig={vi.fn()}
        renderedConfig=""
        isLoadingRaw={false}
        isSavingRaw={false}
        editorErrorLines={[]}
        setEditorErrorLines={vi.fn()}
        onValidate={vi.fn().mockResolvedValue(true)}
        onSaveRaw={vi.fn()}
        onRefreshRendered={vi.fn()}
        dirty
        canManage
      />
    );

    expect(screen.getByText("Raw Config").closest("div.border")).toHaveStyle({
      borderColor: "var(--color-warning)",
    });
  });
});
