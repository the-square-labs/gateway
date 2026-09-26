import { screen } from "@testing-library/react";
import { composeIds } from "../fixtures/docker/data";
import { composeProjectHandlers, detailSetup } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-compose-services", async () => {
  await exportScreen({
    id: "docker-compose-services",
    title: "Compose project · Services",
    group: "Docker",
    route: `/docker/compose/${composeIds.stack}/services`,
    handlers: composeProjectHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findAllByText("redis:7.4-alpine");
    },
  });
});
