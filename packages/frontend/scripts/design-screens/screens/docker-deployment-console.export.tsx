import { screen } from "@testing-library/react";
import { checkoutDeploymentHandlers, detailSetup } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-deployment-console", async () => {
  await exportScreen({
    id: "docker-deployment-console",
    title: "Deployment · Console",
    group: "Docker",
    route: "/docker/deployments/apps-1/checkout/console",
    handlers: checkoutDeploymentHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findByText("Container Console");
    },
    placeholders: [
      { selector: ".terminal-console", label: "Terminal (xterm.js): interactive shell session" },
    ],
  });
});
