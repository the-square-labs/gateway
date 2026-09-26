import { screen } from "@testing-library/react";
import { checkoutDeploymentHandlers, detailSetup } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-deployment-logs", async () => {
  await exportScreen({
    id: "docker-deployment-logs",
    title: "Deployment · Logs",
    group: "Docker",
    route: "/docker/deployments/apps-1/checkout/logs",
    handlers: checkoutDeploymentHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findByText(/Starting gunicorn/);
    },
  });
});
