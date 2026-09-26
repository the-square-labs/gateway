/** Nginx config templates: the list (from the route fixtures) and single-template reads. */
import { HttpResponse, http } from "msw";
import { wrapped } from "../../handlers";
import { nginxTemplates } from "../routes/data";

export const hardenedProxyTemplate = nginxTemplates.find(
  (template) => template.name === "Hardened proxy (HSTS + CSP)"
)!;

export function nginxTemplateHandlers() {
  return [
    http.get("*/api/nginx-templates", () => wrapped(nginxTemplates)),
    http.get("*/api/nginx-templates/:id", ({ params }) => {
      const template = nginxTemplates.find((item) => item.id === params.id);
      return template
        ? wrapped(template)
        : HttpResponse.json({ message: "Not found" }, { status: 404 });
    }),
  ];
}
