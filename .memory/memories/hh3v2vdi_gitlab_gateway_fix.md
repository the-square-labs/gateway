---
{
  "id": "hh3v2vdi",
  "file_name": "hh3v2vdi_gitlab_gateway_fix",
  "tags": [
    "bugfix",
    "docker-registries",
    "gateway",
    "gitlab",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1783267576919,
  "updated_at": 1783267576919
}
---
Project: gateway (wiolett) in /Users/knownout/Projects/wiolett/gateway. Issue: GitLab-provided Docker registries store repository URLs like registry.example.com/group/project/image. Docker Registry API tests must target the registry root /v2/ on the host, not the path <repository>/v2/, otherwise GitLab returns 404 Not Found. For integration-managed GitLab registries that do not provide deploy-token credentials, tests should report a clear missing-credentials result instead of probing unauthenticated path URLs. Note: GitLab registry Bearer token realms are hosted on the GitLab base URL, so trustedAuthRealm should be derived from the connector baseUrl for GitLab-provided registries. Verification methods used: backend lint, backend typecheck, docker-registry service tests, gitlab-provider tests, git diff --check, and a local service call against the development (dev) database.
