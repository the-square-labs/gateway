import { screen } from "@testing-library/react";
import { composeIds } from "../fixtures/docker/data";
import { composeProjectHandlers, detailSetup } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-compose-builds", async () => {
  await exportScreen({
    id: "docker-compose-builds",
    title: "Compose project · Builds",
    group: "Docker",
    route: `/docker/compose/${composeIds.stack}/builds`,
    handlers: composeProjectHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findAllByText("a41c07d2");
    },
    notes: [
      "northwind-stack builds web, api and worker from Git: one build per service, one batch per commit.",
      "The latest batch was applied; the one before stopped because the api image failed the vulnerability policy.",
    ],
  });
});
