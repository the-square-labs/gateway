import { screen } from "@testing-library/react";
import { composeIds } from "../fixtures/docker/data";
import { composeProjectHandlers, detailSetup } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-compose-variables", async () => {
  await exportScreen({
    id: "docker-compose-variables",
    title: "Compose project · Variables",
    group: "Docker",
    route: `/docker/compose/${composeIds.stack}/variables`,
    handlers: composeProjectHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findByDisplayValue("APP_VERSION");
    },
  });
});
