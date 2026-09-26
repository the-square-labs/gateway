import { act, screen } from "@testing-library/react";
import { EDITOR_SELECTOR, markEditors } from "../fixtures/ingress/editor";
import {
  AI_ARTIFACT_FILENAME,
  AI_ARTIFACT_ID,
  aiArtifactHandlers,
} from "../fixtures/overview/ai-artifact";
import { exportScreen } from "../harness";

it("overview-ai-artifact", async () => {
  await exportScreen({
    id: "overview-ai-artifact",
    title: "AI artifact pop-out",
    group: "Overview",
    route: `/ai/artifact/${AI_ARTIFACT_ID}?filename=${AI_ARTIFACT_FILENAME}&mediaType=text/markdown`,
    handlers: aiArtifactHandlers(),
    // Pop-outs render outside the app layout and have no reveal gate to wait for,
    // so this waits for the loaded file itself.
    captureBeforeReveal: async () => {
      await screen.findByRole("button", { name: "Download" }, { timeout: 15_000 });
      await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
      markEditors();
    },
    placeholders: [{ selector: EDITOR_SELECTOR, label: "Artifact text (CodeMirror, read-only)" }],
    notes: ["A Markdown report the assistant wrote in its sandbox, opened in its own window."],
  });
});
