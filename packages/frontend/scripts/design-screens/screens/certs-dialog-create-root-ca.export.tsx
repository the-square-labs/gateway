import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pkiHandlers } from "../fixtures/certs/pki";
import { releaseAnimatedHeights } from "../fixtures/docker/jsdom-shims";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-dialog-create-root-ca", async () => {
  await exportScreen({
    id: "certs-dialog-create-root-ca",
    title: "Create Root CA dialog",
    group: "Certificates",
    route: "/cas",
    handlers: [...pkiHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("Northwind Clients CA");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Create Root CA" }));
      const dialog = await screen.findByRole("dialog", { name: "Create Root CA" });
      await user.type(within(dialog).getAllByRole("textbox")[0], "Northwind Root CA 2026");
      await waitForReveal();
      await releaseAnimatedHeights(dialog);
    },
    notes: ["Creating a new root certificate authority."],
  });
});
