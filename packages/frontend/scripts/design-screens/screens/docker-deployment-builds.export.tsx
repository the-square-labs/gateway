import { screen } from "@testing-library/react";
import { checkoutDeploymentHandlers, detailSetup } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-deployment-builds", async () => {
  await exportScreen({
    id: "docker-deployment-builds",
    title: "Deployment · Builds",
    group: "Docker",
    route: "/docker/deployments/apps-1/checkout/builds",
    handlers: checkoutDeploymentHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findByText("7ad1e0c9d7");
    },
    notes: ["The newest checkout build is still running (building step 6 of 11)."],
  });
});
