import { screen } from "@testing-library/react";
import { checkoutDeploymentHandlers, detailSetup } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-deployment-stats", async () => {
  await exportScreen({
    id: "docker-deployment-stats",
    title: "Deployment · Monitoring",
    group: "Docker",
    route: "/docker/deployments/apps-1/checkout/stats",
    handlers: checkoutDeploymentHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findAllByText(/checkout\.outbox/);
    },
  });
});
