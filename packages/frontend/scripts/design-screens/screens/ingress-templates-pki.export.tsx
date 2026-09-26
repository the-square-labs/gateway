import { screen } from "@testing-library/react";
import { pkiHandlers } from "../fixtures/certs/pki";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-templates-pki", async () => {
  await exportScreen({
    id: "ingress-templates-pki",
    title: "Templates · PKI Certificates",
    group: "Ingress",
    route: "/templates/pki",
    handlers: [...pkiHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("Staff mTLS");
    },
    notes: ["Three built-in certificate templates and two custom ones."],
  });
});
