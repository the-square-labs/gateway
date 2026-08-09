---
{
  "id": "loolos87",
  "file_name": "loolos87_gateway_binary_export",
  "tags": [
    "binary-transport",
    "docker",
    "e2e",
    "gateway"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1786281293798,
  "updated_at": 1786281293798
}
---
For Gateway Docker volume export, do not route tar/gzip bytes through Docker container logs: the logging path is text-oriented and can replace invalid UTF-8 bytes. Use Docker CopyFromContainer to obtain the raw tar stream, gzip it in the daemon with an output bound, carry it in CommandResult.data, return the Buffer unchanged through the service, and construct the HTTP body from Uint8Array. Live verification must check HTTP 200, gzip magic 1f 8b, tar listing, and an exact marker file.
