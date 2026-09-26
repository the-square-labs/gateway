import { screen } from "@testing-library/react";
import { composeIds } from "../fixtures/docker/data";
import { composeProjectHandlers, detailSetup } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-compose-settings", async () => {
  await exportScreen({
    id: "docker-compose-settings",
    title: "Compose project · Settings",
    group: "Docker",
    route: `/docker/compose/${composeIds.stack}/settings`,
    handlers: composeProjectHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findByText("Check eligibility");
    },
  });
});
