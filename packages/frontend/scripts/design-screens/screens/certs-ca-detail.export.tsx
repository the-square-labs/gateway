import { screen } from "@testing-library/react";
import { pkiHandlers, pkiServicesCa } from "../fixtures/certs/pki";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-ca-detail", async () => {
  await exportScreen({
    id: "certs-ca-detail",
    title: "Certificate Authority",
    group: "Certificates",
    route: `/cas/${pkiServicesCa.id}`,
    handlers: [...pkiHandlers(), ...backgroundPrewarmHandlers()],
    height: 1300,
    ready: async () => {
      await screen.findByText("api.internal.example.com");
    },
    notes: ["The services intermediate CA with its latest issued certificates."],
  });
});
