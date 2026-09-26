import { screen } from "@testing-library/react";
import { dockerListHandlers } from "../fixtures/docker/handlers";
import { exportScreen } from "../harness";

it("docker-networks", async () => {
  await exportScreen({
    id: "docker-networks",
    title: "Docker · Networks",
    group: "Docker",
    route: "/docker/networks",
    handlers: dockerListHandlers(),
    ready: async () => {
      await screen.findByText("northwind-db");
    },
  });
});
