---
{
  "id": "mu4tydcq",
  "file_name": "mu4tydcq_apps_architecture_constraints",
  "tags": [
    "apps",
    "architecture",
    "ownership",
    "resources",
    "visibility"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.62,
  "importance": 0.9,
  "created_at": 1780866522759,
  "updated_at": 1784761650112
}
---
Gateway App ownership and resource-model contract:
- A supported app-scoped resource belongs to at most one App. Model this with a nullable app_id on each supported resource table, not a many-to-many link table.
- Resources have two practical states: global/standalone or app-scoped. Creating or linking a resource in an App sets app_id; app-scoped resources are hidden from global/common lists and managed through App UI/API routes.
- Supported App-owned resources are Docker containers and blue/green deployments, database connections, logging environments, access lists, proxy hosts, SSL certificates, and PKI leaf certificates.
- Nodes and PKI certificate authorities remain Gateway-owned root infrastructure. Apps may reference Nodes only as placement/runtime targets or service bindings.
- Linking or creating one resource does not automatically move referenced dependencies such as certificates, access lists, Nodes, or other resources into the App.
