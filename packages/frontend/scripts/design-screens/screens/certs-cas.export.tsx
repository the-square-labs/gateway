import { screen } from "@testing-library/react";
import { pkiHandlers } from "../fixtures/certs/pki";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("certs-cas", async () => {
  await exportScreen({
    id: "certs-cas",
    title: "Certificate Authorities",
    group: "Certificates",
    route: "/cas",
    handlers: [...pkiHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("Northwind Clients CA");
    },
    notes: ["Two roots and two intermediates; the 2021 lab root expires in 25 days."],
  });
});
