import { screen } from "@testing-library/react";
import { dockerListHandlers } from "../fixtures/docker/handlers";
import { exportScreen } from "../harness";

it("docker-volumes", async () => {
  await exportScreen({
    id: "docker-volumes",
    title: "Docker · Volumes",
    group: "Docker",
    route: "/docker/volumes",
    handlers: dockerListHandlers(),
    ready: async () => {
      await screen.findByText("grafana-data");
    },
  });
});
