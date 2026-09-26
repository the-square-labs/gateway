import { screen } from "@testing-library/react";
import { checkoutDeploymentHandlers, detailSetup } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-deployment-environment", async () => {
  await exportScreen({
    id: "docker-deployment-environment",
    title: "Deployment · Environment",
    group: "Docker",
    route: "/docker/deployments/apps-1/checkout/environment",
    handlers: checkoutDeploymentHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findByDisplayValue("PAYMENTS_API_KEY");
    },
  });
});
