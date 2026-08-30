/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/pages/SSLCertificates.tsx"), "utf8");

describe("SSL certificate list contract", () => {
  it("reuses the shared foldered resource list without a custom folder implementation", () => {
    expect(source).toContain("FolderedResourceList<SSLCertificate>");
    expect(source).toContain('resourceType="ssl-certificate"');
    expect(source).toContain('hasScope("ssl:cert:folders:manage")');
    expect(source).toContain("onCreateFolderRef={(fn) => setCreateFolderAction(() => fn)}");
    expect(source).toContain("hasMore && !isLoading && !isLoadingMore && !error");
    expect(source).not.toContain("<DataTable");
  });
});
