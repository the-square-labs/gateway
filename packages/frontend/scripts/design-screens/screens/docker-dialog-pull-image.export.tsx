import { screen } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { dockerListHandlers } from "../fixtures/docker/handlers";
import { releaseAnimatedHeights } from "../fixtures/docker/jsdom-shims";
import { prewarmHandlers } from "../fixtures/docker/prewarm";
import { fillField, pickOption } from "../fixtures/docker/ready";
import { exportScreen } from "../harness";

it("docker-dialog-pull-image", async () => {
  await exportScreen({
    id: "docker-dialog-pull-image",
    title: "Pull Image dialog",
    group: "Docker",
    route: "/docker/images",
    handlers: [...dockerListHandlers(), ...prewarmHandlers()],
    ready: async () => {
      await screen.findAllByText("prom/node-exporter:v1.8.2");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: /^Pull Image$/i }));
      const dialog = await screen.findByRole("dialog");
      await waitForReveal();
      await pickOption(user, dialog, "Select a node", /Apps 1/);
      await fillField(user, dialog, "nginx:latest", "registry.example.com/northwind/web:2.9.0");
      await releaseAnimatedHeights(dialog);
    },
    notes: ["Pulling the next web release onto apps-1 ahead of a rollout."],
  });
});
