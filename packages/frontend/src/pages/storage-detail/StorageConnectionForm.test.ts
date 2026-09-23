import { describe, expect, it } from "vitest";
import type { ObjectStorageConnection } from "@/types";
import { draftFromConnection, secretReentryRequired } from "./StorageConnectionForm";

function connection(overrides: Partial<ObjectStorageConnection>): ObjectStorageConnection {
  return {
    name: "files",
    description: null,
    tags: [],
    endpoint: null,
    region: null,
    accessKeyId: null,
    defaultBucket: null,
    forcePathStyle: false,
    host: null,
    port: null,
    username: null,
    basePath: null,
    implicitTls: false,
    ...overrides,
  } as ObjectStorageConnection;
}

describe("secretReentryRequired", () => {
  const sftp = connection({
    provider: "sftp",
    host: "files.example.com",
    port: 22,
    username: "deploy",
    hasStoredPassword: true,
  });

  it("keeps the stored password for edits that do not move the connection", () => {
    const draft = draftFromConnection(sftp);
    expect(secretReentryRequired(draft)).toBe(false);
    expect(secretReentryRequired({ ...draft, basePath: "/srv", port: "" })).toBe(false);
  });

  it.each([
    ["host", { host: "other.example.com" }],
    ["port", { port: "2222" }],
    ["username", { username: "root" }],
    ["provider", { provider: "ftp" as const }],
  ])("asks for the password again when the %s changes", (_field, change) => {
    expect(secretReentryRequired({ ...draftFromConnection(sftp), ...change })).toBe(true);
  });

  it("does not ask on create or for an anonymous connection", () => {
    expect(secretReentryRequired({ ...draftFromConnection(null), host: "h" })).toBe(false);
    const anonymous = connection({ provider: "ftp", host: "mirror", port: 21, username: "" });
    expect(secretReentryRequired({ ...draftFromConnection(anonymous), host: "other" })).toBe(false);
  });

  it("asks for the S3 secret again when the endpoint or provider changes", () => {
    const s3 = draftFromConnection(
      connection({ provider: "minio", endpoint: "http://minio:9000", hasStoredSecret: true })
    );
    expect(secretReentryRequired(s3)).toBe(false);
    expect(secretReentryRequired({ ...s3, endpoint: "https://elsewhere" })).toBe(true);
    expect(secretReentryRequired({ ...s3, provider: "other" })).toBe(true);
  });
});
