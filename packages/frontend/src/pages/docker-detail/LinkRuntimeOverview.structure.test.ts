import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const containerDetailSource = readFileSync(
  resolve(process.cwd(), "src/pages/DockerContainerDetail.tsx"),
  "utf8"
);
const overviewSource = readFileSync(
  resolve(process.cwd(), "src/pages/docker-detail/OverviewTab.tsx"),
  "utf8"
);

describe("Docker container Link Runtime placement", () => {
  it("renders Link Runtime in Overview before Recent Activity instead of a separate tab", () => {
    expect(containerDetailSource).not.toContain('<TabsTrigger value="link-runtime">');
    expect(containerDetailSource).not.toContain('<TabsContent value="link-runtime"');

    const runtimeIndex = overviewSource.indexOf("<LinkRuntimeTab links={databaseLinks} />");
    const activityIndex = overviewSource.indexOf('title="Recent Activity"');

    expect(runtimeIndex).toBeGreaterThan(-1);
    expect(activityIndex).toBeGreaterThan(runtimeIndex);
  });
});
