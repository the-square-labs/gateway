# Community and the commercial core

Gateway uses one common frontend and common open-source daemon builds. Premium
backend implementations are delivered as a separately signed commercial core.
Building Community does not require access to the private repository.

Community allows 25 managed nodes, 3 users, and 1 custom permission group. Existing
signed v3/v4 paid entitlements remain compatible. Storage connections, external
database connections/explorers, and GitLab integration require Personal or higher
under the current entitlement contract. SMB is not a supported storage connector.

The backend owns permission and license enforcement. UI checks explain a denied
operation; they are not an authorization boundary. A valid license with an absent
or invalid core is reported separately from an insufficient plan.

## Activation

Activating a paid key prepares the matching core for the currently installed
Gateway version through the ordinary signed update mechanism. Gateway keeps
serving requests while preparation runs, then restarts to load the verified core.
License settings offers **Enable paid features** to retry a failed preparation.

Shared system certificates, daemon enrollment/mTLS, ordinary Docker management,
basic AI chat, and Inference remain available in Community. System CA/certificate
primitives stay shared; user PKI entrypoints require the commercial core.

## Update order

1. Verify the target public image manifest and prepare required images.
2. Validate the installation's license online, obtain the exact private release,
   and verify its signature, file sizes, hashes, and host-version compatibility.
3. Store the prepared image/core pair under versioned local paths.
4. Let Foundation wire the prepared local core into the target configuration.
5. Replace Gateway and retain the previous image/core pair for rollback.

The target image provides this preparation bridge for older installed Gateway
versions as well as subsequent updates. Foundation never starts a private download
after Gateway has been stopped. A failed paid authorization or package validation
leaves the current process running and must not silently downgrade it to Community.

The license server must support authenticated release authorization/downloads and
have the matching signed release available before the RC is offered for updates.
Public CI checks the backend source/artifact boundary without private credentials.
Private CI independently tests and signs the commercial package against the exact
host version. Publication does not deploy or update a running Gateway instance.
