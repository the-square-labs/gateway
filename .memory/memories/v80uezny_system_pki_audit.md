---
{
  "id": "v80uezny",
  "file_name": "v80uezny_system_pki_audit",
  "tags": [
    "ai",
    "permissions",
    "pki",
    "system-certificates"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1785948805314,
  "updated_at": 1785948805314
}
---
AI system-PKI access contract: ordinary PKI tools continue to hide system CAs and leaves. The only Assistant entrypoint for system records is `audit_system_pki_leaves`, which requires both `pki:cert:view` and `admin:details:certificates` and returns only lifecycle/evidence metadata. The tool must never expose private keys or perform issuance, revocation, deletion, cleanup, or ownership mutation. Server-side CA and certificate mutation guards remain authoritative.
