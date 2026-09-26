import { screen } from "@testing-library/react";
import { checkoutDeploymentHandlers, detailSetup } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-deployment-settings", async () => {
  await exportScreen({
    id: "docker-deployment-settings",
    title: "Deployment · Settings",
    group: "Docker",
    route: "/docker/deployments/apps-1/checkout/settings",
    handlers: checkoutDeploymentHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findByText("Drain and Entrypoint");
    },
  });
});
