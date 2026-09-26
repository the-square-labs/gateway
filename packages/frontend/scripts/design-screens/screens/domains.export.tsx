import { screen } from "@testing-library/react";
import { exportScreen } from "../harness";
import { domainsHandlers } from "../fixtures/edge/domains";

it("domains", async () => {
  await exportScreen({
    id: "domains",
    title: "Domains",
    group: "Screens",
    route: "/domains",
    handlers: domainsHandlers(),
    ready: async () => {
      await screen.findByText("grafana.example.com");
    },
  });
});
