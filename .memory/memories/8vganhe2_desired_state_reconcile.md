---
{
  "id": "8vganhe2",
  "file_name": "8vganhe2_desired_state_reconcile",
  "tags": [
    "links",
    "managed-databases",
    "reconciler",
    "relay",
    "root-cause"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1790471070526,
  "updated_at": 1790471070526
}
---
Root cause of the rc.13 production incident (fixed in rc.14): `reconcileManagedDatabaseRelayPolicy` (packages/backend/src/services/relay-policy-reconciler.ts) kept relay routes only for links with status 'ready'. Creating a link restarts the workload before the link is ready; the container start triggers the reconciler, which deleted the route, the daemon closed the host listener, an app that needs its DB at start crash-looped (ECONNREFUSED on the link gateway IP), readiness timed out and the link stayed 'creating' forever. A working link that went 'error' after one failed reconcile lost its route the same way.

Rule: any full-table reconciler that tears down runtime resources (routes, listeners, grants, networks, secrets) must key on desiredState/deletion, never on a narrow 'ready' status, because in-flight operations need those resources before they become ready.

Related rc.14 finding: links to TLS-enabled managed PostgreSQL never worked (pg_hba is hostssl-only, the database-side daemon dialled plaintext); fixed in the docker daemon (managed_database_relay_dial.go) by negotiating TLS toward PostgreSQL for link clients.

Verification lesson: unit tests with mocks and code-reading audits missed both; only an end-to-end run of "link a DB to an app that needs it at start" (and a TLS DB) exposes them.
