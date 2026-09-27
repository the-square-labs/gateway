import { waitForPageText } from "../fixtures/data/ready";
import { pagesProfileDisabled, pagesProfileHandlers } from "../fixtures/ingress/pages-states";
import { settingsTabHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("ingress-pages-settings-disabled", async () => {
  await exportScreen({
    id: "ingress-pages-settings-disabled",
    title: "Pages settings · Disabled",
    group: "Ingress",
    route: "/settings/features",
    handlers: [...pagesProfileHandlers(pagesProfileDisabled), ...settingsTabHandlers()],
    height: 2000,
    ready: async () => {
      await waitForPageText("Pages is disabled and hidden from navigation.");
    },
    notes: [
      "A fresh installation: Pages is off, no wildcard Domain or certificate chosen, and Pages is missing from the sidebar.",
    ],
  });
});
