/**
 * Handler sets and setup for the Docker detail screens, so every tab of one
 * resource renders against the same installation.
 */
import { dockerBuildHandlers } from "./builds";
import { dockerComposeDetailHandlers } from "./compose-handlers";
import { dockerComposeRuntimeHandlers, stackRuntimeNames } from "./compose-runtime";
import { dockerContainerDetailHandlers } from "./container-handlers";
import { checkoutRuntimeNames, dockerDeploymentHandlers } from "./deployment";
import { dockerListHandlers } from "./handlers";
import { giveHealthBarsWidth, giveLogViewportHeight } from "./jsdom-shims";
import { dockerRuntimeHandlers } from "./runtime";
import { checkoutLogLines, composeLogLines, installFixtureWebSocket, webLogLines } from "./streams";
import { dockerVolumeHandlers } from "./volume";

/** Content column: 1440 minus the sidebar and page padding. */
export const DETAIL_CONTENT_WIDTH = 1130;

/** Log streams answer with their fixture lines; exec sockets open and stay quiet. */
export function installDockerStreams() {
  installFixtureWebSocket((url) => {
    if (url.includes("/compose/") && url.includes("/logs/stream")) {
      return [{ type: "initial", lines: composeLogLines, hasMore: false }];
    }
    if (url.includes("/logs/stream")) {
      const lines = url.includes("c0ffee0ba1b2") ? checkoutLogLines : webLogLines;
      return [{ type: "initial", lines, hasMore: false }];
    }
    return [];
  });
}

export function detailSetup() {
  giveHealthBarsWidth(DETAIL_CONTENT_WIDTH);
  giveLogViewportHeight();
  installDockerStreams();
}

/** The `web` container on apps-1. */
export function webContainerHandlers() {
  return [
    ...dockerBuildHandlers(),
    ...dockerRuntimeHandlers(),
    ...dockerContainerDetailHandlers(),
    ...dockerListHandlers(),
  ];
}

/** The `northwind-stack` Compose project on apps-2. */
export function composeProjectHandlers() {
  return [
    ...dockerBuildHandlers(),
    ...dockerComposeRuntimeHandlers(),
    ...dockerRuntimeHandlers(stackRuntimeNames),
    ...dockerComposeDetailHandlers(),
    ...dockerListHandlers(),
  ];
}

/** The `checkout` blue/green deployment on apps-1. */
export function checkoutDeploymentHandlers() {
  return [
    ...dockerBuildHandlers(),
    ...dockerRuntimeHandlers(checkoutRuntimeNames),
    ...dockerDeploymentHandlers(),
    ...dockerListHandlers(),
  ];
}

/** The `web-uploads` volume on apps-1. */
export function webUploadsVolumeHandlers() {
  return [...dockerVolumeHandlers(), ...dockerRuntimeHandlers(), ...dockerListHandlers()];
}
