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
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findByText("Connect repository");
    },
    notes: [
      "northwind-stack is deployed from Gateway-stored YAML; the Source tab offers to connect a Git repository.",
    ],
  });
});
