import { describe, expect, it } from "vitest";
import { composeRevisionResumeSignature } from "./compose-adoption-resume";

const input = {
  projectName: "demo",
  yaml: "services:\n  web:\n    image: nginx:alpine\n",
  variables: { B: "2", A: "1" },
  secretKeys: ["TOKEN", "PASSWORD"],
};

describe("Compose adoption resume signature", () => {
  it("is stable for equivalent variable and secret ordering", () => {
    expect(
      composeRevisionResumeSignature({
        ...input,
        variables: { A: "1", B: "2" },
        secretKeys: ["PASSWORD", "TOKEN"],
      })
    ).toBe(composeRevisionResumeSignature(input));
  });

  it.each([
    { yaml: `${input.yaml}  worker:\n    image: busybox\n` },
    { variables: { ...input.variables, A: "changed" } },
    { secretKeys: [...input.secretKeys, "NEW_SECRET"] },
  ])("changes when revision input changes", (change) => {
    expect(composeRevisionResumeSignature({ ...input, ...change })).not.toBe(
      composeRevisionResumeSignature(input)
    );
  });
});
