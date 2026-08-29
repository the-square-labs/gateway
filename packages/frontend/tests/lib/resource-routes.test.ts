import { describe, expect, it } from "vitest";
import {
  databaseRoute,
  dockerContainerRoute,
  dockerDeploymentRoute,
  dockerVolumeRoute,
  loggingEnvironmentRoute,
  loggingSchemaRoute,
  nodeRoute,
  proxyHostRoute,
} from "../../src/lib/resource-routes";

describe("resource route builders", () => {
  it("builds slug routes and preserves optional tabs", () => {
    expect(nodeRoute("edge-node", "monitoring")).toBe("/nodes/edge-node/monitoring");
    expect(databaseRoute("main-db", "overview")).toBe("/databases/main-db/overview");
    expect(proxyHostRoute("example-com")).toBe("/proxy-hosts/example-com");
    expect(loggingEnvironmentRoute("production", "logs")).toBe(
      "/logging/environments/production/logs"
    );
    expect(loggingSchemaRoute("nginx-json")).toBe("/logging/schemas/nginx-json");
  });

  it("URL-encodes exact Docker names without normalizing them", () => {
    expect(dockerContainerRoute("edge", "API Worker", "logs")).toBe(
      "/docker/containers/edge/API%20Worker/logs"
    );
    expect(dockerDeploymentRoute("edge", "API")).toBe("/docker/deployments/edge/API");
    expect(dockerVolumeRoute("edge", "Data+Cache")).toBe("/docker/volumes/edge/Data%2BCache");
  });
});
