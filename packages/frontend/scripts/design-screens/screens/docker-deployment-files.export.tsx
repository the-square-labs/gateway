import { screen } from "@testing-library/react";
import { checkoutDeploymentHandlers, detailSetup } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-deployment-files", async () => {
  await exportScreen({
    id: "docker-deployment-files",
    title: "Deployment · Files",
    group: "Docker",
    route: "/docker/deployments/apps-1/checkout/files",
    handlers: checkoutDeploymentHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findByText("boot");
    },
  });
});
