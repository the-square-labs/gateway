import { screen } from "@testing-library/react";
import { checkoutDeploymentHandlers, detailSetup } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-deployment-overview", async () => {
  await exportScreen({
    id: "docker-deployment-overview",
    title: "Deployment detail",
    group: "Docker",
    route: "/docker/deployments/apps-1/checkout/overview",
    handlers: checkoutDeploymentHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findByText("Active Slot");
    },
    notes: [
      "The checkout deployment serves green (1.14.0); blue keeps 1.13.2 on standby for rollback.",
    ],
  });
});
