import { screen } from "@testing-library/react";
import { dockerBuildHandlers } from "../fixtures/docker/builds";
import { dockerListHandlers } from "../fixtures/docker/handlers";
import { exportScreen } from "../harness";

it("docker-builds", async () => {
  await exportScreen({
    id: "docker-builds",
    title: "Docker · Builds",
    group: "Docker",
    route: "/docker/builds",
    handlers: [...dockerBuildHandlers(), ...dockerListHandlers()],
    ready: async () => {
      await screen.findByText("7ad1e0c9");
    },
    notes: [
      "One checkout build is still running; one web build was blocked by the vulnerability policy.",
    ],
  });
});
