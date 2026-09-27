import { screen } from "@testing-library/react";
import { checkoutDeploymentHandlers, detailSetup } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-deployment-source", async () => {
  await exportScreen({
    id: "docker-deployment-source",
    title: "Deployment · Source",
    group: "Docker",
    route: "/docker/deployments/apps-1/checkout/source",
    handlers: checkoutDeploymentHandlers(),
    height: 1450,
    before: detailSetup,
    ready: async () => {
      await screen.findByText("PIP_INDEX_TOKEN");
    },
    notes: [
      "Repository and Build settings side by side; Sync now checks the branch for new commits right away.",
    ],
  });
});
