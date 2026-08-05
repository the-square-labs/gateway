---
{
  "id": "dv6ewa57",
  "file_name": "dv6ewa57_certificate_cleanup",
  "tags": [
    "certificates",
    "crl",
    "housekeeping",
    "lifecycle",
    "pki"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.95,
  "created_at": 1785947696656,
  "updated_at": 1785965680509
}
---
# System PKI Lifecycle and Ownership

- Every newly issued system leaf must record explicit owner type/id and lifecycle state.
- Insert new leaves as owned `unknown`; atomically promote to `current` only when the owner binding succeeds, while retiring the prior current leaf and setting the issuing CA’s durable CRL-pending marker.
- Managed-database `certificate_id` binding, node owner deletion, and leaf retirement must run in the same transaction. If the owner transition fails, the prior leaf remains current and the issued leaf stays unknown/non-actionable.
- Gateway listener file installation is a lifecycle binding with a compensating rollback handle. If promotion/commit aborts, restore the prior certificate/key pair. Startup recovery must compare any leftover backup against the committed current listener leaf and retain the new pair only when it matches DB state.
- Housekeeping after 30 days may destroy only encrypted private-key fields for explicitly owned `superseded` or `retired` leaves whose issuing CA is verified `isSystem`.
- Destroying a key and recording its redacted per-certificate audit row must be one database transaction. Audit metadata may include cert/CA/owner/lifecycle/retention/trigger, never key or PEM material.
- Preserve certificate rows, PEM, revocation/audit data, CAs, user PKI, SSL/ACME, current leaves, and unknown leaves.
- Retry pending system CRLs at bootstrap and every five minutes; clear the marker only after successful generation.

## Ownership and Assistant Boundaries

- Nodes and PKI certificate authorities remain Gateway-owned root infrastructure. App linkage never transfers referenced ownership.
- Ordinary PKI tools hide system CAs/leaves. The sole Assistant path is read-only `audit_system_pki_leaves`, requiring `pki:cert:view` plus `admin:details:certificates`; it must never expose private keys or mutate system PKI.
