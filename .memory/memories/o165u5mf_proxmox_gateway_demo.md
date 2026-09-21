---
{
  "id": "o165u5mf",
  "file_name": "o165u5mf_proxmox_gateway_demo",
  "tags": [
    "api",
    "demo-stand",
    "gateway",
    "installer",
    "proxmox"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1789952050200,
  "updated_at": 1789952050200
}
---
Gateway demo/e2e stand on Proxmox (verified 2026-09-21):
- Cluster: yuna=172.30.0.2, SORA=172.30.0.3 (guests 1130-1140 live on sora, VLAN 2020, 172.20.0.0/24, reachable from the dev laptop). Users tend to say "SORA is .2" - it is .3. LXC 1130/1133 have bind mounts, so use direct `zfs snapshot` instead of `pct snapshot`. VMs have no qemu guest agent; reach them via root SSH from sora (use `ssh -n` inside heredoc scripts or ssh eats the rest of stdin).
- Details of the current client-demo stand: `.workflow/demo-video-2026-09-21/STAND-STATE.md`.
Fresh-install gotchas:
- `scripts/install.sh` installs only the latest STABLE tag. To reach an RC: set update channel to preview via `PUT /api/admin/auth-settings {generalSettings:{updateChannel:"preview"}}`, then follow the STEPWISE path the release provider offers (2.10.1 -> 2.10.2-rc.11 -> 2.11.0-rc.4); `POST /api/system/update` rejects any version except the advertised next one (VERSION_MISMATCH). Relay updates separately via `/api/system/relay-update`.
- Password/email-OTP sign-in in the setup wizard requires verified SMTP with TLS (starttls|tls only) and a trusted cert. For an offline stand: Mailpit with a self-signed CA, CA copied into the gateway data volume, `NODE_EXTRA_CA_CERTS` added to /opt/gateway/.env (survives updates).
- Auth routes are mounted at `/auth/*`, not `/api/auth/*`. Cookie-session mutations need `X-CSRF-Token` from `GET /auth/csrf`. Many admin scopes (settings, users, groups) are denied to API tokens, so automate with the admin session.
- Setup wizard API: /api/setup/unlock -> wizard/apply -> wizard/license/community|activate -> wizard/complete.
- A paid key moves to a new installation after explicit deactivation or >1h offline of the previous one. PKI is a switchable module, OFF by default even on Enterprise (`generalSettings.features.pkiEnabled`).
- REST `POST /api/docker/nodes/:id/containers` only creates; call `/start` separately. Blue/green `deploy` auto-switches after health check.
- Daemon installers accept `--version vX.Y.Z-rc.N`; enrollment token is returned once by `POST /api/nodes`.
