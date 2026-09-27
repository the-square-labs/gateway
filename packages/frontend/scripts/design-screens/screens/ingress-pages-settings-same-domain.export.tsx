import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { waitForPageText } from "../fixtures/data/ready";
import { pagesProfileDisabled, pagesProfileHandlers } from "../fixtures/ingress/pages-states";
import { settingsTabHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("ingress-pages-settings-same-domain", async () => {
  await exportScreen({
    id: "ingress-pages-settings-same-domain",
    title: "Pages settings · Same registrable domain",
    group: "Ingress",
    route: "/settings/features",
    handlers: [...pagesProfileHandlers(pagesProfileDisabled), ...settingsTabHandlers()],
    height: 2000,
    ready: async () => {
      await waitForPageText("Pages is disabled and hidden from navigation.");
    },
    interact: async (user) => {
      const section = document.getElementById("pages") as HTMLElement;
      await user.click(within(section).getByRole("button", { name: "Enable Pages" }));
      const [domainSelect, certificateSelect] = within(section).getAllByRole("combobox");
      await user.click(domainSelect);
      await user.click(await screen.findByRole("option", { name: /pages\.example\.com/ }));
      await user.click(certificateSelect);
      await user.click(await screen.findByRole("option", { name: "Wildcard pages.example.com" }));
      await within(section).findByText("Separate registrable domain recommended");
      await waitForReveal();
    },
    notes: [
      "Setting Pages up on pages.example.com, which shares example.com with the console: the warning asks for a separate registrable domain.",
    ],
  });
});
