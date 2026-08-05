---
{
  "id": "adzvqx6l",
  "file_name": "adzvqx6l_gwca_permission_boundary",
  "tags": [
    "docker",
    "gwca",
    "permissions",
    "security"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1785532665862,
  "updated_at": 1785532665862
}
---
Gateway container archive export uses a dedicated resource-scoped permission docker:containers:export as an additional gate, not a replacement for protected-data access. Export still requires docker:containers:files and docker:containers:environment on the source container. docker:containers:secrets is optional; it controls both whether the "Include secrets" switch is visible and whether secret values may be included in the export. The export scope is granted by default to system-admin/admin, excluded from operator, and requires manual OAuth approval.
