import { describe, expect, it } from "vitest";
import {
  mergeUpdatedRecord,
  pageRuntimeConfigEditorState,
  validatePageRuntimeConfig,
} from "./PageRuntimeConfigTab";

function runtimeConfigRecord(tagId: string | null, source: string, generation: number) {
  return {
    id: `${tagId ?? "default"}-${generation}`,
    projectId: "project-1",
    tagId,
    source,
    generation,
    updatedAt: "2026-08-17T00:00:00.000Z",
    updatedById: "user-1",
  };
}

describe("validatePageRuntimeConfig", () => {
  it("accepts a JSON object and measures UTF-8 bytes", () => {
    const result = validatePageRuntimeConfig('{\n  "title": "Привет"\n}');

    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
    expect(result.errorLines).toEqual([]);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it.each([
    ["null", "Configuration must be a JSON object."],
    ["[]", "Configuration must be a JSON object."],
    ["42", "Configuration must be a JSON object."],
    ['"secret"', "Configuration must be a JSON object."],
  ])("rejects a non-object root: %s", (source, error) => {
    const result = validatePageRuntimeConfig(source);

    expect(result.valid).toBe(false);
    expect(result.error).toBe(error);
    expect(result.errorLines).toEqual([1]);
  });

  it("marks the JSON parser line for malformed input", () => {
    const result = validatePageRuntimeConfig('{\n  "title":\n}');

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Configuration must be valid JSON.");
    expect(result.errorLines).toEqual([3]);
  });

  it("rejects an object over the 64 KiB limit", () => {
    const result = validatePageRuntimeConfig(`{"payload":"${"x".repeat(64 * 1024)}"}`);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Configuration must be a JSON object no larger than 64 KiB.");
    expect(result.errorLines).toEqual([]);
  });
});

describe("runtime configuration state updates", () => {
  it("refreshes effective configuration for every inherited Tag after saving Default", () => {
    const previousDefault = runtimeConfigRecord(null, '{"theme":"light"}', 1);
    const inheritedTag = {
      id: "tag-inherited",
      name: "Inherited",
      system: false,
      hasOverride: false,
      inherited: true,
      override: null,
      effective: previousDefault,
    };
    const overriddenRecord = runtimeConfigRecord("tag-overridden", '{"theme":"dark"}', 2);
    const overriddenTag = {
      id: "tag-overridden",
      name: "Overridden",
      system: false,
      hasOverride: true,
      inherited: false,
      override: overriddenRecord,
      effective: overriddenRecord,
    };
    const nextDefault = runtimeConfigRecord(null, '{"theme":"system"}', 2);
    const next = mergeUpdatedRecord(
      {
        default: previousDefault,
        overrides: [overriddenRecord],
        tags: [inheritedTag, overriddenTag],
      },
      "default",
      nextDefault
    );

    expect(next.default).toEqual(nextDefault);
    expect(next.tags[0].effective).toEqual(nextDefault);
    expect(next.tags[0].inherited).toBe(true);
    expect(next.tags[1].effective).toEqual(overriddenRecord);
  });

  it("applies the current Default to the editor after a Tag override is reset", () => {
    const defaultRecord = runtimeConfigRecord(null, '{"theme":"system"}', 3);
    const resetSnapshot = {
      default: defaultRecord,
      overrides: [],
      tags: [
        {
          id: "tag-inherited",
          name: "Inherited",
          system: false,
          hasOverride: false,
          inherited: true,
          override: null,
          effective: defaultRecord,
        },
      ],
    };

    expect(pageRuntimeConfigEditorState(resetSnapshot, "tag-inherited")).toEqual({
      source: defaultRecord.source,
      savedSource: defaultRecord.source,
    });
  });
});
