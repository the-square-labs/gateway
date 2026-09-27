import { screen } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { noBuildWorkerHandlers, pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-source-dialog-build-worker", async () => {
  await exportScreen({
    id: "ingress-pages-project-source-dialog-build-worker",
    title: "Pages project · Source · No Build Worker",
    group: "Ingress",
    route: "/pages/marketing-site/source",
    handlers: pagesProjectHandlers(...noBuildWorkerHandlers()),
    ready: async () => {
      await screen.findByText("SENTRY_AUTH_TOKEN");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Build now" }));
      await screen.findByRole("dialog", { name: "Connect a Build Worker First" });
      await waitForReveal();
    },
    notes: [
      "Build now while no Build Worker is connected: the server answers 409 NO_BUILD_WORKER_AVAILABLE (listed in the manifest on purpose).",
    ],
  });
});
