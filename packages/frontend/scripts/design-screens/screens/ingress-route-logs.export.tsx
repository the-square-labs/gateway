import { screen } from "@testing-library/react";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import {
  giveLogListHeight,
  installAccessLogStream,
  routeDetailHandlers,
} from "../fixtures/ingress/route-detail";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-logs", async () => {
  await exportScreen({
    id: "ingress-route-logs",
    title: "Route · Logs",
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
    notes: [
      "Access and error log lines from the route's live log stream (WebSocket stubbed with its first frame).",
    ],
  });
});
