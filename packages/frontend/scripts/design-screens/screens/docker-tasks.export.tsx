import { screen } from "@testing-library/react";
import { dockerBuildHandlers } from "../fixtures/docker/builds";
import { dockerListHandlers } from "../fixtures/docker/handlers";
import { exportScreen } from "../harness";

it("docker-tasks", async () => {
  await exportScreen({
    id: "docker-tasks",
    title: "Docker · Tasks",
    group: "Docker",
    route: "/docker/tasks",
    handlers: [...dockerBuildHandlers(), ...dockerListHandlers()],
    ready: async () => {
      await screen.findAllByText("image-resizer");
    },
    notes: [
      "The image-resizer recreate failed (exit 137, out of memory); grafana was migrated from apps-1 to apps-2 nine days ago.",
    ],
  });
});
