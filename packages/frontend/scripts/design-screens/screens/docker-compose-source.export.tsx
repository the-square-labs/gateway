import { screen } from "@testing-library/react";
import { composeIds } from "../fixtures/docker/data";
import { composeProjectHandlers, detailSetup } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-compose-source", async () => {
  await exportScreen({
    id: "docker-compose-source",
    title: "Compose project · Source",
    group: "Docker",
    route: `/docker/compose/${composeIds.stack}/source`,
    handlers: composeProjectHandlers(),
    height: 1450,
    before: detailSetup,
    ready: async () => {
      await screen.findByText("NPM_TOKEN");
    },
    notes: [
      "northwind-stack builds web, api and worker from northwind/stack on GitLab (compose.yaml).",
      "Repository and Build sit side by side; Sync now checks the branch for new commits right away.",
    ],
  });
});
