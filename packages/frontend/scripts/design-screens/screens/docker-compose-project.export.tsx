import { screen } from "@testing-library/react";
import { exportScreen } from "../harness";
import { dockerComposeDetailHandlers } from "../fixtures/docker/compose-handlers";
import { composeIds } from "../fixtures/docker/data";
import { dockerListHandlers } from "../fixtures/docker/handlers";

it("docker-compose-project", async () => {
  await exportScreen({
    id: "docker-compose-project",
    title: "Compose project",
    group: "Docker",
    route: `/docker/compose/${composeIds.stack}`,
    handlers: [...dockerComposeDetailHandlers(), ...dockerListHandlers()],
    height: 1100,
    ready: async () => {
      await screen.findByText("Recent activity");
      await screen.findAllByText(/pull apply|Pull & Apply/i);
    },
  });
});
