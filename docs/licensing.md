# Licensing

[Back to README](../README.md)

Gateway has two licensing layers:

1. The source license in [LICENSE.md](../LICENSE.md), which defines when you may use, copy, modify, and distribute the software.
2. Product license keys inside Gateway, which identify Community, Homelab, and Enterprise installations.

Today, product license tiers are informational and do not gate features. Future releases may move selected features behind Homelab-and-up or Enterprise tiers. This document describes the intended policy so users can choose the right tier before those gates exist.

## Tier Summary

| Tier | Intended users | Key | Current product behavior |
|------|----------------|-----|--------------------------|
| Community | Personal use, noncommercial organizations, and permitted source-license use under [LICENSE.md](../LICENSE.md). | Not required. | Full product access today. |
| Homelab | Homelab operators and eligible small businesses below the source-license threshold. | Free renewable key by request. | Full product access today. Planned Homelab-and-up perks include Status Pages, PKI, and Logging. |
| Enterprise | Organizations above the small-business threshold or teams that want a paid commercial license. | 290 USD per year. | Full product access today. Planned Enterprise tier remains the paid commercial and support path. |

"Homelab-and-up" means Homelab and Enterprise licenses.

## Current Enforcement

Gateway currently treats license tiers as no-op product entitlements:

- Community works without a license key.
- Homelab and Enterprise keys can be activated in **Settings > General > License**.
- Current releases do not block features by tier.
- License status is displayed so installations can be prepared for future tiered behavior.

Future planned Homelab-and-up perks:

- Status pages.
- PKI infrastructure.
- Structured logging.

If these gates are introduced, they should be documented in release notes before users are expected to rely on them.

## Community

Community requires no product license key.

Community is suitable for:

- Personal testing.
- Noncommercial experiments.
- Evaluation.
- Uses already permitted by [LICENSE.md](../LICENSE.md).

Community installations still receive an installation ID internally so the app can show consistent license status and support later activation.

## Homelab

Homelab keys are free for users who run real homelab infrastructure and for eligible small businesses under the source-license threshold.

Homelab terms:

- Homelab operators: 3 years, renewable on request.
- Eligible small businesses: 1 year, renewable on request while still eligible.

Small-business eligibility:

- Less than 100,000 USD revenue in the prior tax year.
- Fewer than 10 total team members, including employees and independent contractors.

How to request:

- Email [contact@wiolett.net](mailto:contact@wiolett.net), or
- Contact [Wiolett Industries on Telegram](https://t.me/WiolettIndustries).

Request expectation:

- Homelab users: show that you operate a homelab.
- Small businesses: confirm that your organization is below the revenue and team-size thresholds.
- This can be informal. The goal is to confirm eligibility, not to create a heavy approval process.

Homelab keys are intended for personal, hobby, learning, noncommercial infrastructure use, and eligible small-business use.

## Enterprise

Enterprise keys are paid commercial keys.

- Required for organizations above either small-business threshold.
- Price: 290 USD per year.
- Contact [contact@wiolett.net](mailto:contact@wiolett.net) or [Wiolett Industries on Telegram](https://t.me/WiolettIndustries).

Enterprise keys are not issued for free. Eligible small businesses can request a free Homelab key instead.

## License Verification

Gateway verifies product license keys against the Wiolett Industries license server:

```text
https://gw-license-server.wiolett.net
```

Activation flow:

1. An admin enters a license key in **Settings > General > License**.
2. Gateway sends an activation request to the license server.
3. The license server returns license status, tier, license name, expiration, and active installation details.
4. Gateway stores the license key encrypted.
5. Gateway caches the latest license status locally.

Heartbeat flow:

- Gateway checks the stored key periodically.
- Current heartbeat interval: every 12 hours.
- If the license server is unreachable, Gateway uses the cached status.
- Current offline grace period after the last valid check: 30 days.

Data sent to the license server:

- License key.
- Installation ID.
- Installation name.
- Gateway version.

The installation name is derived from Gateway's persisted canonical public URL when possible, otherwise from the host name.

## License Statuses

| Status | Meaning |
|--------|---------|
| `community` | No product key is installed; Gateway is using Community status. |
| `valid` | The installed key is valid. |
| `valid_with_warning` | The key was previously valid, but the license server is currently unreachable and Gateway is within grace. |
| `unreachable_grace_expired` | Gateway cannot validate the key and the offline grace period expired. |
| `invalid` | The license key is not valid. |
| `expired` | The license key expired. |
| `revoked` | The license key was revoked. |
| `replaced` | The license key was replaced by another key or installation. |

## Storage And Security

Gateway stores:

- A generated installation ID.
- The encrypted license key, if one is installed.
- Cached license status returned by the license server.

The license key is encrypted through Gateway's crypto service before storage. Admins can remove the active key from **Settings > General > License**.

## Source License

The source license lives in [LICENSE.md](../LICENSE.md). It is source-available and permits personal, noncommercial, and eligible small-business use under the written terms.

Organizations that do not fit those terms need a separate paid commercial license. In practice, that means using an Enterprise key.

This document explains Wiolett Industries' product licensing policy. If this summary conflicts with [LICENSE.md](../LICENSE.md), the license text controls.
