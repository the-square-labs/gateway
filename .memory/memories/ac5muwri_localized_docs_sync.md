---
{
  "id": "ac5muwri",
  "file_name": "ac5muwri_localized_docs_sync",
  "tags": [
    "ai-docs",
    "database-nodes",
    "documentation",
    "localization"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1785878943106,
  "updated_at": 1785878943106
}
---
Documentation maintenance rule: when Gateway adds or changes a user-visible feature, update all three root README locales (EN/RU/CN), docs/capabilities.md, the relevant operational guide, and packages/backend/src/modules/ai/ai.docs.ts together. Database-node work specifically requires documenting the restricted docker-daemon profile, root-only service user, storage-root selection/preflight, and the difference from ordinary Docker nodes. Verify relative Markdown links and backend typecheck after changing embedded AI documentation.
