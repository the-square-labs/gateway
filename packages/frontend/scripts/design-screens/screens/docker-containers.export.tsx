import { screen } from "@testing-library/react";
import { exportScreen } from "../harness";
import { dockerListHandlers } from "../fixtures/docker/handlers";
import { expandContainerFolders } from "../fixtures/docker/stores";

it("docker-containers", async () => {
  await exportScreen({
    id: "docker-containers",
    title: "Docker · Containers",
    group: "Docker",
    route: "/docker/containers",
    handlers: dockerListHandlers(),
    height: 1000,
    before: expandContainerFolders,
    ready: async () => {
      await screen.findByText("postgres-sidecar");
    },
    notes: [
      "Compose-owned containers are not listed here by design (the snapshot API excludes them); they appear under the Compose tab.",
    ],
  });
});
