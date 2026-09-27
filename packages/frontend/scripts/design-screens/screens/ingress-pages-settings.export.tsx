import { waitFor } from "@testing-library/react";
import { waitForPageText } from "../fixtures/data/ready";
import { pagesProfileConfigured, pagesProfileHandlers } from "../fixtures/ingress/pages-states";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { settingsTabHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("ingress-pages-settings", async () => {
  await exportScreen({
    id: "ingress-pages-settings",
    title: "Pages settings",
    group: "Ingress",
    route: "/settings/features",
    handlers: [
      ...pagesProfileHandlers(pagesProfileConfigured),
      ...settingsTabHandlers(),
      ...backgroundPrewarmHandlers(),
    ],
    height: 2000,
    before: () => {
      // Pages → Settings navigates here with the Pages section as its scroll target.
      window.history.replaceState(
        { usr: { scrollTarget: "pages" }, key: "pages-settings", idx: 0 },
        "",
        "/settings/features"
      );
    },
    ready: async () => {
      await waitForPageText("Hostname label template", "Cookie isolation warning accepted");
      // The Pages section flashes once when the navigation lands on it; capture after it settles.
      await waitFor(() => {
        if (!document.querySelector(".navigation-target-ripple")) throw new Error("not reached");
      });
      await waitFor(
        () => {
          if (document.querySelector(".navigation-target-ripple")) throw new Error("highlighted");
        },
        { timeout: 10_000 }
      );
    },
    notes: [
      "Pages → Settings opens Settings · Features at the Pages section (the same tab as Administration → Settings · Features).",
      "Previews live under pages.example.com, which shares example.com with the console; that override was acknowledged at setup.",
    ],
  });
});
