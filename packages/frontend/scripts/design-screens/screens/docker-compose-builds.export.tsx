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
      await screen.findByText("No builds yet.");
    },
    notes: ["northwind-stack is YAML-based, so it has no Git builds (empty state)."],
  });
});
