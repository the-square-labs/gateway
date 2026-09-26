import { screen } from "@testing-library/react";
import { pkiHandlers } from "../fixtures/certs/pki";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-certificates", async () => {
  await exportScreen({
    id: "certs-certificates",
    title: "Certificates",
    group: "Certificates",
    route: "/certificates",
    handlers: [...pkiHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("orders-db.internal.example.com");
    },
    notes: [
      "Active certificates issued by the internal CAs (the default filter hides revoked ones).",
    ],
  });
});
