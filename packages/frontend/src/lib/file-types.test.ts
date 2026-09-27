import { codeEditorLanguageForFile } from "./file-types";

describe("codeEditorLanguageForFile", () => {
  it.each([
    ["/etc/nginx/nginx.conf", "nginx"],
    ["/etc/nginx/conf.d/default.conf", "nginx"],
    ["/etc/nginx/sites-enabled/default", "nginx"],
    ["site.nginx", "nginx"],
    ["/srv/app/.env", "env"],
    ["/srv/app/.env.production", "env"],
    ["worker.env", "env"],
    ["/catalog-export.json", "json"],
    ["docker-compose.yml", "yaml"],
    ["values.YAML", "yaml"],
    ["migrations/001_init.sql", "sql"],
    ["config.xml", "xml"],
    ["README.md", "plain"],
    ["Dockerfile", "plain"],
    ["/home/app/.bashrc", "plain"],
    ["notes.txt", "plain"],
  ])("reads %s as %s", (path, language) => {
    expect(codeEditorLanguageForFile(path)).toBe(language);
  });

  it("falls back to the media type when the extension says nothing", () => {
    expect(codeEditorLanguageForFile("result", "application/json; charset=utf-8")).toBe("json");
    expect(codeEditorLanguageForFile("payload", "application/vnd.api+json")).toBe("json");
    expect(codeEditorLanguageForFile("manifest", "application/x-yaml")).toBe("yaml");
    expect(codeEditorLanguageForFile("feed", "application/atom+xml")).toBe("xml");
    expect(codeEditorLanguageForFile("query", "application/sql")).toBe("sql");
    expect(codeEditorLanguageForFile("report.md", "text/markdown")).toBe("plain");
  });

  it("prefers the extension over the media type", () => {
    expect(codeEditorLanguageForFile("stack.yaml", "text/plain")).toBe("yaml");
  });
});
