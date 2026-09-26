import { screen } from "@testing-library/react";
import { dockerListHandlers } from "../fixtures/docker/handlers";
import { exportScreen } from "../harness";

it("docker-compose-projects", async () => {
  await exportScreen({
    id: "docker-compose-projects",
    title: "Docker · Compose",
    group: "Docker",
    route: "/docker/compose",
    handlers: dockerListHandlers(),
    ready: async () => {
      await screen.findByText("analytics-pipeline");
    },
    notes: [
      "analytics-pipeline on apps-1 has drifted from its active revision (2 of 3 services running).",
    ],
  });
});
