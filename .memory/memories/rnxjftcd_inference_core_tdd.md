---
{
  "id": "rnxjftcd",
  "file_name": "rnxjftcd_inference_core_tdd",
  "tags": [
    "inference-core",
    "providers",
    "tdd",
    "testing",
    "workflow"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1787354224184,
  "updated_at": 1787354224184
}
---
The active .workflow plan `wiolett-inference-core` requires contract and behavior-first TDD across E00-E29. Modes are explicit per shard: contract-first for E01; strict TDD for implementation shards; characterization TDD for imported/consumer subscription behavior; verification-first for E25-E27; gate-first for E00, E24, E28, and E29. Accepted test oracles cannot be weakened after implementation; contradicted expectations return `NEEDS_CONTRACT_CHANGE` to the main integrator. Luna-authored oracles require grouped Sol/integrator review. Authorized live provider calls validate sanitized fixtures and detect drift but do not replace deterministic tests. Strict/contract/characterization handoffs preserve test-first and implementation SHAs plus RED/GREEN and affected-conformance evidence.
