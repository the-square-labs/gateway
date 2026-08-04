# Gateway database connector

This first-party sidecar exposes a managed database TCP port only inside one
private Docker binding network. It forwards raw bytes through the Docker
daemon's Unix socket after a fixed binding-ID handshake. The container never
receives Gateway credentials, a database destination address, or a direct
database credential.

## How Gateway uses it

When an operator creates a binding from a managed Postgres, Redis, or
ClickHouse instance to a Docker container or deployment, Gateway creates a
dedicated database identity and private network attachment. The connector is
the only route from that workload to the database; Gateway injects the chosen
connection environment variables into the workload, not into this sidecar.

Bindings are private by default. Publishing a database TCP endpoint is a
separate, explicit managed-database setting and is not required for a binding.
Deleting a binding removes its database identity and private connector path.

## Release and operation requirements

The release pipeline must publish this image under an immutable digest before
it is added to the managed binding catalog. Gateway accepts only a
`DATABASE_CONNECTOR_IMAGE` reference in the
`.../database-connector@sha256:<digest>` form and refuses new bindings when
the reference is absent or mutable.

The connector has no standalone user configuration or public port. Diagnose a
failed binding from the managed database and target workload in Gateway; do
not copy connector aliases, binding environment values, or database
credentials into logs or notifications.
