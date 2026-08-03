# Installer migration contract

The Node frontend is the public interface. It resolves copied flags, prompts
for missing values, then calls the engine with `-y`; it never runs `npm` on the
target host. This table distinguishes the existing legacy scripts from the
current engine so releases do not overstate migration coverage.

| Flow | Legacy script contract | Current engine status |
| --- | --- | --- |
| Gateway | Docker/Compose prerequisites, config generation, existing-install update, domain/OIDC/SSL setup, local or remote PostgreSQL, local/remote/disabled ClickHouse logging, first-run bootstrap | Config generation, Compose startup, local ClickHouse safety file, and first-run bootstrap are implemented. Existing-install migration and the full OS/package/SSL matrix still require parity work. |
| Nginx node | OS package installation, managed or integrated nginx configuration, daemon install/enrollment, systemd/OpenRC startup | Daemon install/enrollment and systemd service are implemented. Managed/integrated configuration and OpenRC parity remain. |
| Docker node | Docker Engine discovery/install, daemon install/enrollment, service startup | Docker package discovery, daemon install/enrollment, and systemd service are implemented. Distribution-specific Docker setup and OpenRC parity remain. |
| Databases node | Docker flow plus a selected image-storage root, ext4 image preflight and database daemon profile | Target-host storage selection, root validation, ext4 preflight, and profile writing are implemented. It inherits Docker-node parity gaps. |
| Monitoring node | Daemon install/enrollment and system service lifecycle | Daemon install/enrollment and systemd service are implemented. OpenRC parity remains. |

The external `scripts/install.sh` and `scripts/setup-*.sh` entrypoints are
compatibility loaders only. The archive is the supported distribution unit.
