---
{
  "id": "ov8vmocj",
  "file_name": "ov8vmocj_grpc_optional_cert",
  "tags": [
    "compatibility",
    "daemon",
    "gateway",
    "grpc",
    "mtls"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1777128935634,
  "updated_at": 1777128935634
}
---
In the gateway repo, @grpc/grpc-js `ServerCredentials.createSsl(rootCerts, keyPairs, false)` sets `requestCert: false`, so the server will not request daemon client certificates and `extractNodeIdFromCert()` will usually return null. To keep enrollment working while still allowing CommandStream/LogStream handlers to require verified daemon certs, use `grpc.experimental.createCertificateProviderServerCredentials` with the same static provider for CA and identity and `requireClientCertificate=false`; this sets `requestCert: true` and `rejectUnauthorized: false`. Then `extractNodeIdFromCert()` must check `socket.authorized === true` before trusting the CN.
