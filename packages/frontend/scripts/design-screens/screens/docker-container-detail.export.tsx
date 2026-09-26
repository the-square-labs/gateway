import { screen } from "@testing-library/react";
import { exportScreen } from "../harness";
import { dockerContainerDetailHandlers } from "../fixtures/docker/container-handlers";
import { dockerListHandlers } from "../fixtures/docker/handlers";
import { giveHealthBarsWidth } from "../fixtures/docker/jsdom-shims";

it("docker-container-detail", async () => {
  await exportScreen({
    id: "docker-container-detail",
    title: "Container detail",
    group: "Screens",
    route: "/docker/containers/apps-1/web",
    handlers: [...dockerContainerDetailHandlers(), ...dockerListHandlers()],
    height: 1100,
    // Content column: 1440 minus the sidebar and page padding.
    before: () => giveHealthBarsWidth(1130),
    ready: async () => {
      await screen.findByText("Port Mappings");
    },
  });
});
