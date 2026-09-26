import { screen } from "@testing-library/react";
import { exportScreen } from "../harness";
import { adminHandlers } from "../fixtures/ops/handlers";

it("admin-users", async () => {
  await exportScreen({
    id: "admin-users",
    title: "Users",
    group: "Administration",
    route: "/admin/users",
    handlers: adminHandlers(),
    ready: async () => {
      await screen.findByText("Priya Raman");
    },
  });
});
