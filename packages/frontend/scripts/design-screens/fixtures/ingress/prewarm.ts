/**
 * The console layout warms its caches in the background, one list every 350ms
 * (src/services/api.ts `prefetchAll`). How far that queue gets depends on how
 * long a screen takes, so a slow run can reach lists the screen itself never
 * reads. These answer the lists at the front of that queue with the same
 * installation data, so every run's manifest stays clean. Pass them last.
 */
import { http } from "msw";
import { wrapped } from "../../handlers";
import { pkiHandlers } from "../certs/pki";
import { databaseHandlers } from "../data/database-handlers";
import { pagesHandlers } from "../data/pages-handlers";
import { domainsHandlers } from "../edge/domains";
import { routeHandlers } from "../routes/handlers";

export function backgroundPrewarmHandlers() {
  return [
    ...routeHandlers(),
    ...pagesHandlers(),
    ...pkiHandlers(),
    ...domainsHandlers(),
    ...databaseHandlers(),
    http.get("*/api/logging/environments", () => wrapped([])),
    http.get("*/api/logging/schemas", () => wrapped([])),
  ];
}
