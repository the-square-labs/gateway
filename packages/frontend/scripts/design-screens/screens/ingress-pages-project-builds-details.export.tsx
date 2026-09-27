import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { giveLogViewportHeight } from "../fixtures/docker/jsdom-shims";
import { buildLogHandlers, pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-builds-details", async () => {
  await exportScreen({
    id: "ingress-pages-project-builds-details",
    title: "Pages project · Builds · Build details",
    group: "Ingress",
    route: "/pages/marketing-site/builds",
    handlers: pagesProjectHandlers(...buildLogHandlers()),
    height: 1000,
    before: () => giveLogViewportHeight(),
    ready: async () => {
      await screen.findByText(/Cannot find module/);
    },
    interact: async (user) => {
      await user.click(screen.getByText(/Cannot find module/));
      const dialog = await screen.findByRole("dialog", { name: "Build Details" });
      await within(dialog).findByText(/Build failed: pnpm run build exited/);
      await waitForReveal();
    },
    notes: [
      "The failed build of commit c71d5e3: the build script could not resolve a missing locale file; its log ends with the error.",
    ],
  });
});
