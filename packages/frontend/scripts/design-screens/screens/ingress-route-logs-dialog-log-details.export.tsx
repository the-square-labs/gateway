import { screen } from "@testing-library/react";
import { settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import {
  giveLogListHeight,
  installAccessLogStream,
  routeDetailHandlers,
} from "../fixtures/ingress/route-detail";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-logs-dialog-log-details", async () => {
  await exportScreen({
    id: "ingress-route-logs-dialog-log-details",
    title: "Route · Log Details",
    group: "Ingress",
    route: "/proxy-hosts/app/logs",
    handlers: [...routeDetailHandlers(), ...routeHandlers(), ...backgroundPrewarmHandlers()],
    before: () => {
      measureHealthBars();
      giveLogListHeight();
      installAccessLogStream();
    },
    ready: async () => {
      await screen.findByText("/api/v1/orders");
    },
    interact: async (user) => {
      await user.click(screen.getByText("/api/v1/orders"));
      await settleDialog("Log Details");
    },
    notes: ["One access log line opened: POST /api/v1/orders answered 201."],
  });
});
