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
  "created_at": 1785947696656,
  "updated_at": 1785947696656
}
---
System leaf lifecycle safety pattern: write explicit owner type/id and lifecycle state directly on every newly issued system leaf. Insert it first as owned `unknown`; only atomically promote it to `current` while retiring the previous current leaf and setting the issuing CA's durable CRL-pending marker. If binding fails, the new leaf remains visible but non-actionable and is never automatically cleaned. On owner deletion, retire only explicitly owned leaves. Housekeeping destroys only encrypted private-key fields for owned `superseded`/`retired` leaves after 30 days; certificate rows, PEM, revocation/audit data, system CAs, user PKI, SSL/ACME, current leaves, and unknown records are excluded. Retry pending system CRLs at bootstrap and every five minutes; clear the marker only after successful CRL generation.
