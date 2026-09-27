import { screen } from "@testing-library/react";
import { fillCAForm } from "../fixtures/certs/creation";
import { pkiHandlers, pkiRootCa, preparePkiLists } from "../fixtures/certs/pki";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-dialog-ca-intermediate-from-ca", async () => {
  await exportScreen({
    id: "certs-dialog-ca-intermediate-from-ca",
    title: "Create Intermediate CA · From the parent CA",
    group: "Certificates",
    route: `/cas/${pkiRootCa.id}`,
    handlers: [...pkiHandlers(), ...backgroundPrewarmHandlers()],
    before: preparePkiLists,
    ready: async () => {
      await screen.findByText("Child CAs");
    },
    interact: async (user) => {
      // The header folds its actions into the overflow menu when they do not fit.
      const inline = screen.queryByRole("button", { name: "Create Intermediate" });
      if (inline) {
        await user.click(inline);
      } else {
        await user.click(screen.getByRole("button", { name: "Page actions" }));
        await user.click(await screen.findByRole("menuitem", { name: "Create intermediate CA" }));
      }
      const dialog = await screen.findByRole("dialog", { name: "Create Intermediate CA" });
      await fillCAForm(user, dialog, {
        commonName: "Northwind Edge CA",
        algorithm: "ECDSA P-256",
        years: "5",
        pathLength: "0",
        maxDays: "397",
      });
    },
    notes: ["Opened from the root CA's page, the parent is fixed, so there is no parent picker."],
  });
});
