import { screen } from "@testing-library/react";
import { nginxTemplateHandlers } from "../fixtures/ingress/nginx-templates";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-templates-nginx", async () => {
  await exportScreen({
    id: "ingress-templates-nginx",
    title: "Templates · Nginx Config",
    group: "Ingress",
    route: "/templates/nginx",
    handlers: [...nginxTemplateHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("Long-poll API");
    },
    notes: ["Three built-in route templates and two custom proxy templates."],
  });
});
