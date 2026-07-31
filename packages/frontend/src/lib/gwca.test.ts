import { describe, expect, it } from "vitest";
import { readGwcaImportMetadata } from "./gwca";

const MAGIC = new Uint8Array([0x47, 0x57, 0x43, 0x41, 0x0d, 0x0a, 0x1a, 0x0a]);

function archiveFile(manifest: unknown): File {
  const payload = new TextEncoder().encode(JSON.stringify(manifest));
  const header = new Uint8Array(9);
  header[0] = 1;
  new DataView(header.buffer).setBigUint64(1, BigInt(payload.length));
  return new File([MAGIC, header, payload], "container.gwca", {
    type: "application/vnd.wiolett.gwca",
  });
}

describe("readGwcaImportMetadata", () => {
  it("reads supported remap metadata without loading the image payload", async () => {
    const file = archiveFile({
      format: "gwca",
      version: 1,
      container: {
        schemaVersion: 1,
        name: "portable-app",
        networks: [
          { name: "metrics", driver: "bridge", createable: true },
          { name: "application", driver: "overlay", createable: false, requiresMapping: true },
        ],
        mounts: [
          { type: "bind", source: "/srv/app", target: "/app", readOnly: false },
          {
            type: "volume",
            source: "shared-data",
            target: "/data",
            readOnly: true,
            driver: "nfs",
            requiresMapping: true,
          },
        ],
        ports: [{ containerPort: 8080, hostPort: 8080, protocol: "tcp" }],
        secrets: { DATABASE_PASSWORD: "sensitive" },
        warnings: ["Runtime endpoint addresses are reassigned on import."],
      },
    });

    await expect(readGwcaImportMetadata(file)).resolves.toEqual({
      name: "portable-app",
      networks: [
        { name: "metrics", driver: "bridge", createable: true },
        { name: "application", driver: "overlay", createable: false, requiresMapping: true },
      ],
      mounts: [
        { type: "bind", source: "/srv/app", target: "/app", readOnly: false },
        {
          type: "volume",
          source: "shared-data",
          target: "/data",
          readOnly: true,
          driver: "nfs",
          requiresMapping: true,
        },
      ],
      ports: [{ containerPort: 8080, hostPort: 8080, protocol: "tcp" }],
      secretKeys: ["DATABASE_PASSWORD"],
      warnings: ["Runtime endpoint addresses are reassigned on import."],
    });
  });

  it("rejects files without the GWCA header", async () => {
    const file = new File(["not-a-gwca-archive-file"], "invalid.gwca");
    await expect(readGwcaImportMetadata(file)).rejects.toThrow("Gateway container archive");
  });

  it("rejects raw Docker fields outside the GWCA whitelist", async () => {
    const file = archiveFile({
      format: "gwca",
      version: 1,
      container: {
        schemaVersion: 1,
        name: "legacy-app",
        hostConfig: { Privileged: true },
      },
    });
    await expect(readGwcaImportMetadata(file)).rejects.toThrow(
      "Unsupported Gateway container archive"
    );
  });
});
