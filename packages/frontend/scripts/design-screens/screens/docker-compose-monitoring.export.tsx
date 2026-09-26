import { screen } from "@testing-library/react";
import { composeIds } from "../fixtures/docker/data";
import { composeProjectHandlers, detailSetup } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-compose-monitoring", async () => {
  await exportScreen({
    id: "docker-compose-monitoring",
    title: "Compose project · Monitoring",
    group: "Docker",
    route: `/docker/compose/${composeIds.stack}/monitoring`,
    handlers: composeProjectHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findAllByText(/redis-server/);
    },
  });
});
