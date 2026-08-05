---
{
  "id": "35fip13o",
  "file_name": "35fip13o_gateway_permissions_mvp",
  "tags": [
    "apps",
    "architecture",
    "health",
    "lifecycle",
    "permissions",
    "routing"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.75,
  "importance": 0.85,
  "created_at": 1780866370686,
  "updated_at": 1784761658729
}
---
Gateway App lifecycle, routing, permissions, and health contract:
- MVP flow: create a simple App, then create supported resources with the standard domain flow or explicitly link existing global resources. App creation sets app_id immediately; logging may prefill a namespace from App context.
- App detail uses /apps/:id. App slugs are globally unique for display/search and possible future human-readable links, but stable IDs remain the MVP route/API key.
- Global resource detail/list APIs must hide app-scoped resources; app-scoped resources are accessed through App UI/API routes.
- App-level permissions govern management of app-scoped resources inside the App without separately requiring each underlying resource-domain scope. Moving a resource global -> App, App -> global, or App -> App requires explicit permission and audit.
- Dependencies referenced by a moved resource are not moved implicitly.
- There is no archive/unarchive lifecycle in MVP. Apps remain active until deletion.
- Delete an App only when it has no app-scoped resources. Never cascade-delete or silently detach resources; users must explicitly delete or move/unlink them first.
- App health derives only from participating app-scoped resources with health checks enabled: offline wins over degraded, degraded wins over online, all healthy is online, and no participating resources is unknown.
