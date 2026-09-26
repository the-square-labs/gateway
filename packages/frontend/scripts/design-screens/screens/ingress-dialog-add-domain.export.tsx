import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { releaseAnimatedHeights } from "../fixtures/docker/jsdom-shims";
import { domainsHandlers } from "../fixtures/edge/domains";
import { domainPreviewHandlers } from "../fixtures/ingress/domains";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-dialog-add-domain", async () => {
  await exportScreen({
    id: "ingress-dialog-add-domain",
    title: "Add Domain dialog",
    group: "Ingress",
    route: "/domains",
    handlers: [...domainPreviewHandlers(), ...domainsHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("grafana.example.com");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Add Domain" }));
      const dialog = await screen.findByRole("dialog", { name: "Add Domain" });
      await user.type(within(dialog).getAllByRole("textbox")[0], "billing.example.com");
      await user.type(within(dialog).getAllByRole("textbox")[1], "Invoices and payment portal");
      const nodePicker = within(dialog)
        .getAllByRole("combobox")
        .find((element) => element.textContent?.includes("Select node"));
      if (nodePicker) {
        await user.click(nodePicker);
        await user.click(await screen.findByRole("option", { name: /Edge Frankfurt/ }));
      }
      await waitForReveal();
      await releaseAnimatedHeights(dialog);
    },
    notes: ["Adding billing.example.com with Cloudflare-managed DNS."],
  });
});
