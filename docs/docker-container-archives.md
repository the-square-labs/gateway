# GWCA Container Archives

[Back to README](../README.md)

Gateway Container Archive (`.gwca`) is a streaming format for moving or copying a standalone Docker container between Gateway-managed nodes. It is a portable container configuration, not a backup format: named-volume contents and external application data are never included.

## Archive contents

GWCA v1 contains a Gateway-owned, versioned manifest with only settings that Gateway can safely create again:

- image identity and the original registry reference when available;
- entrypoint, command, working directory, user, hostname, and supported labels;
- ordinary environment values;
- optional secret values;
- published ports;
- bind and named-volume declarations;
- attached network metadata;
- restart policy, stop timeout, and supported CPU, memory, and PID limits;
- either an embedded Docker image or an immutable registry digest.

The manifest is deliberately not a serialized Docker inspect response. Containers using unsupported or host-sensitive settings, such as privileged mode, devices or GPUs, host namespaces, capabilities, custom runtimes, custom log drivers, health checks, or unsupported resource controls, are rejected during export with an explicit reason instead of producing an incomplete archive.

Ordinary environment values are always included. Secrets are excluded by default and are included only when **Include secrets** is enabled by a user with secret access. Secret values inside a `.gwca` file are plaintext archive data; the downloaded file must be handled as sensitive. On import, Gateway encrypts them again with the destination Gateway key.

## Image modes

Open a standalone container and choose **Export archive**:

- **Portable** embeds the exact Docker image. The archive can be imported without registry access and streams from Docker through the daemon and Gateway directly to the browser.
- **Registry-backed** stores the exact image ID and an immutable repository digest without embedding the image. The target node must already have that image or be able to pull it through a public registry or registry credentials configured in Gateway. Registry credentials are never written into the archive.

Portable mode can optionally capture the current writable layer with a non-pausing Docker commit. This does not interrupt the container, but concurrent writes are not transactionally consistent. Database data belongs in volumes and needs database-native backup tooling; writable-layer capture is not a live database backup.

## Import planning and remapping

Open **Docker > Containers**, choose **Import .gwca**, select the archive and target node, and confirm the container name. Gateway reads only the local manifest before upload and builds a best-effort import plan:

- an occupied container name receives the next available suffix automatically;
- compatible existing networks are reused;
- portable missing networks are created when the user has network-create access;
- networks that cannot be reproduced fall back to the target node's default `bridge` network;
- source IP and MAC addresses are discarded so Docker allocates destination-local endpoint addresses;
- local named volumes are recreated empty with unique names, so old same-named data is never attached accidentally;
- non-local or plugin-backed volumes must be mapped to a compatible existing destination volume;
- bind mounts remain explicit and their destination-node host paths can be changed before import;
- occupied host ports are shown for remapping; port `0` asks Docker to allocate a free host port.

The imported container remains stopped. Gateway restores ordinary environment values and encrypts imported secrets before publishing the created container to the rest of Gateway. If persistence fails after Docker creation, Gateway removes the partial container and archive-created resources.

The export/import UI is available only for standalone containers. Gateway deployment members continue to be managed through their deployment.

## API

- `GET /api/docker/nodes/{nodeId}/containers/{containerId}/archive?imageMode=portable&includeWritableLayer=false&includeSecrets=false` streams an archive. Export requires container file and environment access; `includeSecrets=true` additionally requires secret access. `imageMode=registry` does not allow writable-layer capture.
- `POST /api/docker/nodes/{nodeId}/containers/archive?name={newName}&resolution={json}` accepts an `application/vnd.wiolett.gwca` body and requires container-create and environment access on the target node. The optional `resolution` object can contain `networks`, `bindPaths`, `volumes`, and `ports` mappings. Importing secret values additionally requires secret access; creating archive-declared local volumes or missing networks requires the corresponding create permissions.

Example resolution:

```json
{
  "networks": { "source-app": "target-app" },
  "bindPaths": { "/srv/source": "/srv/target" },
  "volumes": { "shared-nfs": "target-nfs" },
  "ports": { "8080/tcp:8080": 18080 }
}
```

## Wire format and integrity

GWCA v1 starts with the eight-byte magic `GWCA\r\n\x1a\n`, followed by length-delimited frames:

1. JSON manifest;
2. in portable mode, image frames with at most 1 MiB of image bytes and an individual SHA-256 checksum;
3. JSON footer containing the manifest digest, complete image-stream digest, and image byte count.

Registry-backed archives contain no image frames and use the SHA-256 digest of an empty image stream. Each frame begins with a one-byte type and an unsigned 64-bit big-endian payload length. The media type is `application/vnd.wiolett.gwca`.

The framing supports constant-memory daemon/backend transport with backpressure. The browser may retain the completed download as a `Blob` so it can hand the file to the operating system.
