import { screen } from "@testing-library/react";
import { exportScreen } from "../harness";
import { pagesHandlers } from "../fixtures/data/pages-handlers";

it("state-empty", async () => {
  await exportScreen({
    id: "state-empty",
    title: "Empty state",
    group: "States",
    route: "/pages",
    // A fresh installation: Pages is licensed and configured, no project exists yet.
    handlers: pagesHandlers({ projects: [] }),
    ready: async () => {
      await screen.findByText(/No Page Projects yet/);
    },
    notes: ["Pages list with zero projects: the real EmptyState with its Create project action."],
  });
});
