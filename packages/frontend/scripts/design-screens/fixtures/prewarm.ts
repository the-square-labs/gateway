/**
 * The console layout warms its caches in the background, one list every 350ms
 * (src/services/api.ts `prefetchAll`). How far that queue gets depends on how long
 * a screen takes, so a slow run reaches lists the screen itself never reads. The
 * harness answers them for every screen, after the screen's own and the shell's
 * handlers, with the same installation data the area screens use.
 */
import { pkiHandlers } from "./certs/pki";
import { sslHandlers } from "./edge/ssl";
import { backgroundPrewarmHandlers as ingressPrewarmHandlers } from "./ingress/prewarm";
import { loggingHandlers, settingsHandlers, settingsTabHandlers, statusPageHandlers } from "./ops/handlers";

export function backgroundPrewarmHandlers() {
  return [
    ...ingressPrewarmHandlers(),
    ...sslHandlers(),
    ...pkiHandlers(),
    ...loggingHandlers(),
    ...settingsHandlers(),
    ...settingsTabHandlers(),
    ...statusPageHandlers(),
  ];
}
