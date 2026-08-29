# Screenshot capture list

Capture screenshots with a non-production demonstration instance. Use synthetic names and data. Hide browser bookmarks, operating-system notifications, account avatars, API tokens, setup codes, private/public IP addresses, certificate fingerprints, repository URLs, commit authors, environment values, secrets, and customer domains unless the item explicitly requires a safe example.

| ID | Page | Capture | Suggested state |
| --- | --- | --- | --- |
| `portal-hero-dashboard` | Portal home | Main Dashboard | Healthy nginx, Docker, database, and Relay; one non-sensitive alert |
| `product-tour-navigation` | Product tour | Expanded primary navigation | Major workspaces visible |
| `install-setup-code-terminal` | Install | Installer completion terminal | URL visible; code and host details redacted |
| `setup-wizard-auth` | Initial setup | Authentication-method wizard step | Synthetic provider values |
| `node-create-dialog` | First node | Role picker and generated command | Token and fingerprint redacted |
| `first-route-editor` | First Route | Route editor | Domain, TLS, and managed upstream selected |
| `journey-route-managed-upstream` | Publish application | Healthy Route detail | Deployment target through managed upstream |
| `git-build-detail` | Git to production | Completed build detail | Commit, worker, digest, logs, vulnerability result |
| `database-binding-ready` | Private database | Binding detail | Healthy connector and target workload |
| `pages-project-release` | Static site | Pages Project detail | Deployments, Tags, and Route |
| `domain-route-certificate-chain` | Domains, Routes, TLS | Domain detail | Placement and linked resources |
| `container-detail-tabs` | Containers | Container detail | Major operational tabs visible; secret values hidden |
| `compose-project-revision` | Compose | Revision validation/diff | Diagnostics and Pull & Apply action |
| `observability-dashboard` | Observability | Monitoring dashboard | Metrics, alerts, and recent events |
| `groups-scope-editor` | Identity | Group permission editor | Global and resource-scoped grants |
| `ai-workspace-plan` | AI Workspace | Reviewed plan | Synthetic conversation and resources |
| `node-detail-capabilities` | Nodes and daemons | Node detail | Version, capabilities, metrics, and update state |
| `certificate-detail-renewal` | SSL certificates | Certificate detail | Issuer, expiry, linked Routes, and renewal state |

## Capture conventions

- Desktop baseline: `1440x900`, browser zoom 100%.
- Use the default light theme for the primary set; add dark-theme variants only if the future portal design requires them.
- Prefer PNG for UI screenshots.
- Keep the pointer away from tooltips unless the tooltip is the subject.
- Capture one clean state per image; avoid transient loading spinners.
- Store original captures outside Git until redaction is reviewed.
