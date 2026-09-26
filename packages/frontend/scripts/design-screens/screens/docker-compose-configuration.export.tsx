import { screen } from "@testing-library/react";
import { composeIds } from "../fixtures/docker/data";
import { composeProjectHandlers, detailSetup } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-compose-configuration", async () => {
  await exportScreen({
    id: "docker-compose-configuration",
    title: "Compose project · Configuration",
    group: "Docker",
    route: `/docker/compose/${composeIds.stack}/configuration`,
    handlers: composeProjectHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findByText("Active immutable configuration");
    },
    placeholders: [
      { selector: ".cm-editor", label: "Compose YAML editor (CodeMirror, read-only): revision 7" },
    ],
  });
});
