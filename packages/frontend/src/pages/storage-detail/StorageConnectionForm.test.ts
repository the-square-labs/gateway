import { describe, expect, it } from "vitest";
import type { ObjectStorageConnection } from "@/types";
import {
  buildStoragePayload,
  draftFromConnection,
  secretReentryRequired,
} from "./StorageConnectionForm";

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

describe("buildStoragePayload for an unchanged file-protocol connection", () => {
  // The API asks for the secret again when the CA or host key fingerprint it
  // receives differs from the stored one, so an untouched form must echo both.
  it("sends the stored SFTP host key fingerprint back exactly", () => {
    const fingerprint = "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU";
    const sftp = connection({
      provider: "sftp",
      host: "files.example.com",
      port: 22,
      username: "deploy",
      hostKeyFingerprint: fingerprint,
      hasStoredPassword: true,
    });

    const config = buildStoragePayload(draftFromConnection(sftp)).config as Record<string, unknown>;

    expect(config.hostKeyFingerprint).toBe(fingerprint);
    expect(config).not.toHaveProperty("caPem");
    expect(config).not.toHaveProperty("password");
  });

  it("leaves a stored FTPS CA certificate out of the payload so it is kept as stored", () => {
    const ftps = connection({
      provider: "ftps",
      host: "files.example.com",
      port: 21,
      username: "deploy",
      hasStoredPassword: true,
      hasStoredCaPem: true,
    });

    const config = buildStoragePayload(draftFromConnection(ftps)).config as Record<string, unknown>;

    expect(config).not.toHaveProperty("caPem");
    expect(config).not.toHaveProperty("hostKeyFingerprint");
  });
});
