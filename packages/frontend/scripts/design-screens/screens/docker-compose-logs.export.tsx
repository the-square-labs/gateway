import { screen } from "@testing-library/react";
import { composeIds } from "../fixtures/docker/data";
import { composeProjectHandlers, detailSetup } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-compose-logs", async () => {
  await exportScreen({
    id: "docker-compose-logs",
    title: "Compose project · Logs",
    group: "Docker",
    route: `/docker/compose/${composeIds.stack}/logs`,
    handlers: composeProjectHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findByText(/Background saving started/);
    },
  });
});
