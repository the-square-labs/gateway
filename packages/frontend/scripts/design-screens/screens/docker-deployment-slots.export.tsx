import { screen } from "@testing-library/react";
import { checkoutDeploymentHandlers, detailSetup } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-deployment-slots", async () => {
  await exportScreen({
    id: "docker-deployment-slots",
    title: "Deployment · Slots",
    group: "Docker",
    route: "/docker/deployments/apps-1/checkout/slots",
    handlers: checkoutDeploymentHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findByText("Blue slot");
    },
  });
});
