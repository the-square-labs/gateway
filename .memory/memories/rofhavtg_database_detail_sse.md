---
{
  "id": "rofhavtg",
  "file_name": "rofhavtg_database_detail_sse",
  "tags": [
    "backups",
    "databases",
    "frontend",
    "gateway-commercial",
    "sse"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1790021811035,
  "updated_at": 1790021811035
}
---
# Managed database detail page: backend location, SSE and loading contract

- The real databases and backups backend (routes, services, scheduler) lives in the sibling repo `../gateway-commercial/backend/{databases,backups}`. In this repo `packages/backend/src/modules/databases|backups/*.service.ts` and `databases.routes.ts` are community stubs (`commercialModuleUnavailable()`); only OpenAPI docs (`databases.docs.ts`), schemas and the `database-route-runtime.ts` contract are here. Trace database bugs in gateway-commercial first.
- Every SSE route must set `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` before `streamSSE` (precedent: node monitoring stream in `modules/nodes/nodes.routes.ts`). Without them a reverse proxy buffers the small initial events until a later write flushes them: the database monitoring stream showed metric blocks 2–3 s late, and an offline database (no snapshots ever emitted) never delivered its `connected` event with the health history.
- `pages/DatabaseDetail.tsx` contract: `load()` owns health status/history (REST `health-history`) and writes them to the monitoring cache; effects keyed on the `database` object must not reset them. The monitoring EventSource is keyed by route id (opens in parallel with `load()`, does not reconnect on reload). `load()` shows the page skeleton only for a new id; refreshing the same database must not unmount tabs.
- Database detail tabs cache their lists with `api.getCached/setCache` and show Skeleton rows on first load only (precedent `PostgresExtensionsTab`, applied to `DatabaseBackupsTab` with key `database:backups:<id>`).
- Dialog layout precedent for multi-field database dialogs: `RedisConfigDialog` (`DialogContent "flex max-h-[88dvh] flex-col sm:max-w-3xl"` + PanelShell sections + SettingsControlRow). Tables inside PanelShell use `bodyClassName="p-0"` + `DataTable embedded` (otherwise double border). Button already sizes/gaps its svg — no `mr-1 h-3.5 w-3.5` on icons. No native `<details>`.
- Backup runner python tests need `paramiko`; locally they run with a stub package on PYTHONPATH. Go daemon tests under the sandbox need `GOCACHE=$TMPDIR/gocache CGO_ENABLED=0`.
