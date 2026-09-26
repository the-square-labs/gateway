/** Fixture API handlers for the ops screens: notifications, logging, settings, administration, profile. */
import { HttpResponse, http } from "msw";
import { ok, wrapped } from "../../handlers";
import {
  auditEntries,
  certificateAuthorities,
  databaseConnections,
  deletedUsers,
  groups,
  proxyHosts,
  users,
} from "./admin";
import { loggingEnvironments, loggingEvents, loggingMetadata, loggingSchemas } from "./logging";
import {
  alertRules,
  deliveries,
  page,
  siemDeliveries,
  siemDestinations,
  webhooks,
} from "./notifications";
import {
  browserSessions,
  inferenceSelfUsage,
  inferenceUsageOverview,
  localAccountUser,
  mfaStatus,
  passkeys,
} from "./profile";
import { authSettings, licenseStatus, systemVersion } from "./settings";

const paginated = <T>(data: T[], limit = 100) =>
  ok({ data, pagination: { page: 1, limit, total: data.length, totalPages: 1 } });

const notFound = () => HttpResponse.json({ message: "Not found" }, { status: 404 });

export function notificationsHandlers() {
  return [
    http.get("*/api/notifications/alert-rules", () => ok(page(alertRules))),
    http.get("*/api/notifications/webhooks", () => ok(page(webhooks))),
    http.get("*/api/notifications/deliveries", () => ok(page(deliveries))),
    http.get("*/api/notifications/deliveries/stats", () =>
      wrapped({ total: 1_284, success: 1_271, failed: 9, retrying: 4 })
    ),
    http.get("*/api/audit/siem/destinations", () => ok(page(siemDestinations))),
    http.get("*/api/audit/siem/deliveries", () => ok(page(siemDeliveries))),
  ];
}

export function loggingHandlers() {
  return [
    http.get("*/api/logging/environments/by-slug/:slug", ({ params }) => {
      const environment = loggingEnvironments.find((item) => item.slug === params.slug);
      return environment ? wrapped(environment) : notFound();
    }),
    http.get("*/api/logging/environments", () => wrapped(loggingEnvironments)),
    http.get("*/api/logging/environment-folders", () => wrapped([])),
    http.get("*/api/logging/schemas", () => wrapped(loggingSchemas)),
    http.get("*/api/logging/schema-folders", () => wrapped([])),
    http.get("*/api/logging/environments/:id/metadata", () => wrapped(loggingMetadata)),
    http.post("*/api/logging/environments/:id/search", ({ params }) =>
      ok({
        data: loggingEvents.filter((event) => event.environmentId === params.id),
        nextCursor: null,
      })
    ),
    http.get("*/api/logging/environments/:id/facets", () =>
      wrapped({
        services: loggingMetadata.services,
        sources: loggingMetadata.sources,
        severities: ["debug", "info", "warn", "error"].map((severity) => ({
          severity,
          count: loggingEvents.filter((event) => event.severity === severity).length,
        })),
        labels: loggingMetadata.labelValues,
      })
    ),
  ];
}

export function settingsHandlers() {
  return [
    http.get("*/api/admin/auth-settings", () => ok(authSettings)),
    http.get("*/api/system/version", () => wrapped(systemVersion)),
    http.get("*/api/system/license/status", () => wrapped(licenseStatus)),
    http.get("*/api/system/release-notes", () =>
      wrapped([{ version: "2.14.0", notes: "Relay lanes, SIEM export retries and faster route reloads." }])
    ),
  ];
}

export function adminHandlers() {
  return [
    http.get("*/api/admin/users", () => ok(users)),
    http.get("*/api/admin/users/deleted", () => ok(deletedUsers)),
    http.get("*/api/admin/user-folders", () => wrapped([])),
    http.get("*/api/admin/groups", () => ok(groups)),
    http.get("*/api/admin/groups/folders", () => wrapped([])),
    // Scope pickers of the group and user permission editors.
    http.get("*/api/proxy-hosts", () => paginated(proxyHosts)),
    http.get("*/api/databases", () => paginated(databaseConnections)),
    http.get("*/api/cas", () => ok(certificateAuthorities)),
    http.get("*/api/logging/schemas", () => wrapped(loggingSchemas)),
    http.get("*/api/audit", () => paginated(auditEntries)),
  ];
}

export function profileHandlers() {
  return [
    http.get("*/auth/me", () => ok(localAccountUser)),
    http.get("*/auth/me/mfa", () => ok(mfaStatus)),
    http.get("*/auth/me/passkeys", () => ok(passkeys)),
    http.get("*/auth/me/sessions", () => ok(browserSessions)),
    http.get("*/api/inference/usage/self", () => ok(inferenceSelfUsage)),
    http.get("*/api/inference/usage/self/overview", () => ok(inferenceUsageOverview)),
  ];
}
