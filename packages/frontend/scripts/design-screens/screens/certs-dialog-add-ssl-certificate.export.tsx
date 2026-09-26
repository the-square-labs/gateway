import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pkiHandlers } from "../fixtures/certs/pki";
import { releaseAnimatedHeights } from "../fixtures/docker/jsdom-shims";
import { domainsHandlers } from "../fixtures/edge/domains";
import { sslHandlers } from "../fixtures/edge/ssl";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-dialog-add-ssl-certificate", async () => {
  await exportScreen({
    id: "certs-dialog-add-ssl-certificate",
    title: "Add SSL Certificate dialog",
    group: "Certificates",
    route: "/ssl-certificates",
    handlers: [
      ...sslHandlers(),
      ...domainsHandlers(),
      ...pkiHandlers(),
      ...backgroundPrewarmHandlers(),
    ],
    ready: async () => {
      await screen.findByText("grafana.example.com", { selector: "p.font-medium" });
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Add Certificate" }));
      const dialog = await screen.findByRole("dialog", { name: "Add SSL Certificate" });
      await waitForReveal();
      const domains = within(dialog)
        .getAllByRole("combobox")
        .find((element) => element.tagName === "INPUT")!;
      await user.click(domains);
      await user.click(await screen.findByRole("button", { name: /^billing\.example\.com/ }));
      await user.click(within(dialog).getByText("Domains"));
      await releaseAnimatedHeights(dialog);
    },
    notes: [
      "Requesting a Let's Encrypt certificate for billing.example.com over Cloudflare DNS-01.",
    ],
  });
});
