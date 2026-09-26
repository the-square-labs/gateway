import { screen } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { dockerListHandlers } from "../fixtures/docker/handlers";
import { releaseAnimatedHeights } from "../fixtures/docker/jsdom-shims";
import { prewarmHandlers } from "../fixtures/docker/prewarm";
import { fillField, pickOption } from "../fixtures/docker/ready";
import { exportScreen } from "../harness";

it("docker-dialog-create-volume", async () => {
  await exportScreen({
    id: "docker-dialog-create-volume",
    title: "Create Volume dialog",
    group: "Docker",
    route: "/docker/volumes",
    handlers: [...dockerListHandlers(), ...prewarmHandlers()],
    ready: async () => {
      await screen.findAllByText("grafana-data");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: /^Create Volume$/i }));
      const dialog = await screen.findByRole("dialog");
      await waitForReveal();
      await pickOption(user, dialog, "Select a node", /Apps 1/);
      await fillField(user, dialog, "my-volume", "reports-cache");
      await releaseAnimatedHeights(dialog);
    },
    notes: ["A new regular volume for the reporting worker on apps-1."],
  });
});
