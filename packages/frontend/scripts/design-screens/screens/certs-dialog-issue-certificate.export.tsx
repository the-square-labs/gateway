import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pkiHandlers } from "../fixtures/certs/pki";
import { releaseAnimatedHeights } from "../fixtures/docker/jsdom-shims";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-dialog-issue-certificate", async () => {
  await exportScreen({
    id: "certs-dialog-issue-certificate",
    title: "Issue Certificate dialog",
    group: "Certificates",
    route: "/certificates",
    handlers: [...pkiHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("orders-db.internal.example.com");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Issue Certificate" }));
      const dialog = await screen.findByRole("dialog", { name: "Issue Certificate" });
      await waitForReveal();
      const [caPicker, templatePicker] = within(dialog).getAllByRole("combobox");
      await user.click(caPicker);
      await user.click(await screen.findByRole("option", { name: /Northwind Services CA/ }));
      await user.click(templatePicker);
      await user.click(await screen.findByRole("option", { name: /Internal service/ }));
      await releaseAnimatedHeights(dialog);
    },
    notes: [
      "Step 1 of issuing a certificate: the services CA with the 90-day internal service template.",
    ],
  });
});
