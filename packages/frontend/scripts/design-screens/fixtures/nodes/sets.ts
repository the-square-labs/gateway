/** Handler sets and setup for the Nodes screens. */
import { http } from "msw";
import { wrapped } from "../../handlers";
import { databaseHandlers } from "../data/database-handlers";
import { dockerBuildHandlers } from "../docker/builds";
import { dockerListHandlers } from "../docker/handlers";
import { giveDaemonLogListHeight } from "../docker/jsdom-shims";
import { nodeDetailHandlers } from "../edge/node-detail";
import { nodeListHandlers } from "../edge/nodes";
import { systemConfig } from "../shell";
import { hostingHandlers } from "./hosting";
import { installNodeStreams, nodeTabHandlers } from "./node-tabs";

/** The node list: every node (the Build worker included) and the Proxmox integration. */
export function nodesListHandlers() {
  return [...hostingHandlers(), ...nodeTabHandlers(), ...nodeListHandlers()];
}

/** A node's detail page with every tab's data. */
export function nodeScreenHandlers() {
  return [
    ...hostingHandlers(),
    ...nodeTabHandlers(),
    http.get("*/api/system/config", () => wrapped(systemConfig)),
    ...dockerBuildHandlers(),
    ...databaseHandlers(),
    ...dockerListHandlers(),
    ...nodeDetailHandlers(),
  ];
}

export function nodeScreenSetup() {
  giveDaemonLogListHeight();
  installNodeStreams();
}
