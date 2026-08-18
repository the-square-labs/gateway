import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { preparePageArchive, preparePageFolder } from "./pages-manual-upload";

function folderFile(path: string, content: string): File {
  const file = new File([content], path.split("/").at(-1) ?? path, { type: "text/plain" });
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
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
});
