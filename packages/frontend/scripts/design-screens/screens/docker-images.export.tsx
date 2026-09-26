import { screen } from "@testing-library/react";
import { dockerListHandlers } from "../fixtures/docker/handlers";
import { exportScreen } from "../harness";

it("docker-images", async () => {
  await exportScreen({
    id: "docker-images",
    title: "Docker · Images",
    group: "Docker",
    route: "/docker/images",
    handlers: dockerListHandlers(),
    ready: async () => {
      await screen.findByText("prom/node-exporter:v1.8.2");
    },
  });
});
