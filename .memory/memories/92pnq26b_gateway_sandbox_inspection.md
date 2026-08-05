---
{
  "id": "92pnq26b",
  "file_name": "92pnq26b_gateway_sandbox_inspection",
  "tags": [
    "ai-tools",
    "clone",
    "gateway",
    "gitlab",
    "production-readiness",
    "sandbox",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.55,
  "importance": 0.5,
  "created_at": 1783530886860,
  "updated_at": 1783631267749
}
---
In the project at /Users/knownout/Projects/wiolett/gateway, the same-process clone inspection contract is narrower than a working checkout. The tools list_artifact_files, read_artifact, and send_artifact operating on the returned processId should inspect and hand off the extracted GitLab archive without launching a second sandbox process; these tools remain AI-only/excluded from MCP. The clone process currently runs a fixed extract-then-sleep command, and write_process_stdin is not an exec API. Every run_process creates a fresh workspace, and the archive has no .git metadata. Therefore the current clone can perform read-only inspection only and must not be documented or planned as supporting edits, tests, builds, git diff, or multi-file tooling. A production-grade fix requires a durable workspace/session identity with bounded exec and write/patch primitives plus explicit git or archive-to-patch semantics. The 2026-07-09 audit also confirmed that workspaceBytes is passed through policy but not enforced on the host bind mount; quota and expanded-archive limits must be verified with mandatory Linux Docker tests.
