import { gzipSync, strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { preparePageArchive, preparePageFolder, sha256Hex } from "./pages-manual-upload";

function folderFile(path: string, content: string): File {
  const file = new File([content], path.split("/").at(-1) ?? path, { type: "text/plain" });
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

function tarEntry(path: string, content = ""): Uint8Array {
  const header = new Uint8Array(512);
  header.set(strToU8(path), 0);
  header.set(strToU8("0000644\0"), 100);
  header.set(strToU8(`${content.length.toString(8).padStart(11, "0")}\0`), 124);
  header[156] = path.endsWith("/") ? "5".charCodeAt(0) : "0".charCodeAt(0);
  const body = strToU8(content);
  const output = new Uint8Array(512 + Math.ceil(body.length / 512) * 512);
  output.set(header);
  output.set(body, 512);
  return output;
}

describe("Pages manual upload archive preparation", () => {
  it("normalizes a ZIP with one wrapper directory to tar.gz", async () => {
    const zip = zipSync({
      "site/index.html": strToU8("<h1>Hello</h1>"),
      "site/assets/app.js": strToU8("console.log(1)"),
    });
    const result = await preparePageArchive(new File([zip], "site.zip"));

    expect(result.archive.name).toBe("site.tar.gz");
    expect(result.archive.type).toBe("application/gzip");
    expect(result.fileCount).toBe(2);
    expect(result.sourceLabel).toBe("site.zip");
    await expect(preparePageArchive(result.archive)).resolves.toMatchObject({ fileCount: 2 });
  });

  it("strips the selected folder name and accepts index.htm", async () => {
    const result = await preparePageFolder([
      folderFile("dist/index.htm", "<h1>Hello</h1>"),
      folderFile("dist/css/app.css", "body{}"),
    ]);

    expect(result.fileCount).toBe(2);
    expect(result.sourceLabel).toBe("dist");
    await expect(preparePageArchive(result.archive)).resolves.toMatchObject({ fileCount: 2 });
  });

  it("rejects builds without a root entrypoint", async () => {
    const zip = zipSync({ "assets/app.js": strToU8("console.log(1)") });

    await expect(preparePageArchive(new File([zip], "site.zip"))).rejects.toThrow(
      "index.html or index.htm"
    );
  });

  it("accepts standard tar archives with a dot root directory", async () => {
    const root = tarEntry("./");
    const index = tarEntry("./index.html", "<h1>Hello</h1>");
    const tar = new Uint8Array(root.length + index.length + 1024);
    tar.set(root);
    tar.set(index, root.length);

    await expect(
      preparePageArchive(new File([gzipSync(tar)], "site.tar.gz"))
    ).resolves.toMatchObject({ fileCount: 1 });
  });

  it("calculates SHA-256 without Web Crypto", async () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    try {
      await expect(sha256Hex(new Blob(["hello"]))).resolves.toBe(
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
      );
    } finally {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
    }
  });
});
