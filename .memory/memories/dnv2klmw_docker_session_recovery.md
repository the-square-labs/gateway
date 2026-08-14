---
{
  "id": "dnv2klmw",
  "file_name": "dnv2klmw_docker_session_recovery",
  "tags": [
    "compose",
    "docker",
    "localhost",
    "session-recovery",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1786637391117,
  "updated_at": 1786637391117
}
---
For the gateway-upgrade-e2e localhost stand, replacing only the app container with a newly built Gateway image preserves browser/session data because PostgreSQL, Redis, and Gateway volumes remain intact. Before recreating app, compare the existing container's effective DATABASE_URL and compose environment with the chosen env file: the repo-adjacent env file may omit or disagree with the already-running database credential. Pass the existing effective database configuration without recording its secret, then require /health to report lifecycleState running before handing the stand back.
