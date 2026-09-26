import { screen } from "@testing-library/react";
import { exportScreen } from "../harness";
import { databaseHandlers } from "../fixtures/data/database-handlers";
import { databaseFolders } from "../fixtures/data/databases";
import { expandFolders } from "../fixtures/data/folders";

it("databases-list", async () => {
  await exportScreen({
    id: "databases-list",
    title: "Databases",
    group: "Data",
    route: "/databases",
    handlers: databaseHandlers(),
    before: () => {
      expandFolders(
        "database",
        databaseFolders.map((folder) => folder.id)
      );
    },
    ready: async () => {
      await screen.findByText("events-warehouse");
    },
  });
});
