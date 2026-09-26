import { HttpResponse, http } from "msw";
import {
  certificateAuthorities,
  dashboardBootstrap,
  dashboardBootstrapStats,
} from "./fixtures/dashboard";
import { adminUser } from "./fixtures/identity";
import { nodeBySlug, nodeById, nodeDetail, nodes } from "./fixtures/nodes";
import { updateStatus, uiBootstrap } from "./fixtures/shell";

export const ok = (data: unknown) => HttpResponse.json(data as Record<string, unknown>);
export const wrapped = (data: unknown) => HttpResponse.json({ data } as Record<string, unknown>);

/** Endpoints every screen needs: startup probes, session and the shell read model. */
export function shellHandlers() {
  return [
    http.get("*/health", () => ok({ status: "ok", lifecycleState: "running" })),
    http.get("*/api/setup/status", () => wrapped({ state: "complete" })),
    http.get("*/auth/csrf", () => ok({ csrfToken: "design-fixture" })),
    http.get("*/auth/me", () => ok(adminUser)),
    http.get("*/auth/me/preferences", () =>
      ok({
        aiApprovalMode: "normal",
        preferredInterface: "operations_console",
        preferredInterfaceSelectedAt: "2026-01-10T09:00:00Z",
      })
    ),
    http.get("*/api/ui/bootstrap", () => wrapped(uiBootstrap)),
    http.post("*/api/monitoring/dashboard/bootstrap", async ({ request }) =>
      wrapped(
        dashboardBootstrap(
          ((await request.json().catch(() => null)) ?? {}) as Parameters<typeof dashboardBootstrap>[0]
        )
      )
    ),
    http.get("*/api/inference/usage/self", () => wrapped(null)),
    http.get("*/api/monitoring/dashboard", () => wrapped(dashboardBootstrapStats)),
    http.get("*/api/monitoring/health-status", () =>
      wrapped(dashboardBootstrap({}).health)
    ),
    // Background prewarm on every screen; the certificate authorities fill PKI pickers.
    http.get("*/api/cas", () => ok(certificateAuthorities)),
    // Nodes are shared by most screens (pickers, placement, sidebar).
    http.get("*/api/nodes", ({ request }) => {
      const url = new URL(request.url);
      const type = url.searchParams.get("type");
      const data = nodes.filter((node) => !type || type === "all" || node.type === type);
      return ok({ data, total: data.length, page: 1, limit: 50, totalPages: 1 });
    }),
    http.get("*/api/nodes/folders", () => wrapped([])),
    http.get("*/api/nodes/by-slug/:slug", ({ params }) => {
      const node = nodeBySlug(String(params.slug));
      return node ? wrapped(nodeDetail(node)) : HttpResponse.json({}, { status: 404 });
    }),
    http.get("*/api/nodes/:id", ({ params }) => {
      const node = nodeById(String(params.id));
      return node ? wrapped(nodeDetail(node)) : HttpResponse.json({}, { status: 404 });
    }),
    http.get("*/api/system/update/status", () => wrapped(updateStatus)),
  ];
}
