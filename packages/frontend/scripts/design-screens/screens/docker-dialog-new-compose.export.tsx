import { screen } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { composeCapableNodeHandlers, dockerListHandlers } from "../fixtures/docker/handlers";
import { releaseAnimatedHeights } from "../fixtures/docker/jsdom-shims";
import { prewarmHandlers } from "../fixtures/docker/prewarm";
import { fillField, pickOption } from "../fixtures/docker/ready";
import { exportScreen } from "../harness";

it("docker-dialog-new-compose", async () => {
  await exportScreen({
    id: "docker-dialog-new-compose",
    title: "New Compose project dialog",
    group: "Docker",
    route: "/docker/compose/new",
    handlers: [...composeCapableNodeHandlers(), ...dockerListHandlers(), ...prewarmHandlers()],
    ready: async () => {
      await screen.findAllByText("analytics-pipeline");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: /^New Project$/i }));
      const dialog = await screen.findByRole("dialog");
      await waitForReveal();
      await fillField(user, dialog, "my-project", "northwind-staging");
      await pickOption(user, dialog, "Select node", /Apps 2/);
      await releaseAnimatedHeights(dialog);
    },
    placeholders: [
      { selector: "[role=dialog] .cm-editor", label: "Compose YAML editor (CodeMirror)" },
    ],
    notes: [
      "Opened from /docker/compose/new, which lands on the Compose tab with this dialog; the YAML editor keeps its starter file.",
    ],
  });
});
