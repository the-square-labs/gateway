import { screen } from "@testing-library/react";
import { exportScreen } from "../harness";
import { domainsHandlers } from "../fixtures/edge/domains";

it("domains", async () => {
  await exportScreen({
    id: "domains",
    title: "Domains",
    group: "Ingress",
    route: "/domains",
    handlers: domainsHandlers(),
    ready: async () => {
      await screen.findByText("grafana.example.com");
    },
  });
});
