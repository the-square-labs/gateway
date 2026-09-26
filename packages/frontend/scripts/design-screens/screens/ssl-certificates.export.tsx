import { screen } from "@testing-library/react";
import { exportScreen } from "../harness";
import { domainsHandlers } from "../fixtures/edge/domains";
import { sslHandlers } from "../fixtures/edge/ssl";

it("ssl-certificates", async () => {
  await exportScreen({
    id: "ssl-certificates",
    title: "SSL certificates",
    group: "Certificates",
    route: "/ssl-certificates",
    handlers: [...sslHandlers(), ...domainsHandlers()],
    ready: async () => {
      await screen.findByText("grafana.example.com", { selector: "p.font-medium" });
    },
  });
});
