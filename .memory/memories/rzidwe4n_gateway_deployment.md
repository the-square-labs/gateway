---
{
  "id": "rzidwe4n",
  "file_name": "rzidwe4n_gateway_deployment",
  "tags": [
    "deployment",
    "docker",
    "gateway",
    "staging"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1785951397694,
  "updated_at": 1785951397694
}
---
Gateway host `172.20.0.131` (`test-gw-main`) runs Compose from `/opt/gateway/docker-compose.yml` with `/opt/gateway/.env`; the app uses local image `gateway:current-worktree-amd64`. For a current-worktree deployment, sync source to `/opt/gateway-test-source` excluding `.git`, `node_modules`, `dist`, and `.env`; build a candidate tag `gateway:current-worktree-amd64-next`; inspect its ID; tag it to `gateway:current-worktree-amd64`; then run `docker compose --project-directory /opt/gateway -f /opt/gateway/docker-compose.yml --env-file /opt/gateway/.env up -d --force-recreate app`. This recreates only app and leaves PostgreSQL/Redis running. Verify the container uses candidate image, health is `healthy`, and `/health` returns status ok. Last verified candidate image was sha256:c0f36e99fb836e4aa8638a4a3940d032321df365309ff2b1f49237c3f09e42e8.
