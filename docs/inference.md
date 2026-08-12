# Multi-provider inference proxy

Gateway exposes a standalone OpenAI- and Anthropic-compatible inference data plane. It is isolated from AI Workspace and the MCP runtime: it uses dedicated provider credentials, `gwi_` user tokens, model access rules, accounting, and continuation storage.

The server-side connector baseline is OpenCodex commit `357acee62458684bc027e9d524e95bd066df3a43`. Cursor, Kiro, and OpenCodex desktop lifecycle features are intentionally excluded.

## Enable inference

Inference is disabled by default. An administrator with Gateway settings access enables it under **Settings > General > General settings > Inference**. No process restart is required.

When disabled, management and data-plane routes return `INFERENCE_DISABLED`, and the frontend omits Inference usage, token management, and administration surfaces. Connected provider credentials, model configuration, and accounting history remain stored.

Apply database migrations before enabling the flag. Roll out admin scopes first, configure and verify providers/models, then grant `feat:ai:use` and token scopes to a limited user group.

## Administrator setup

1. Open **Settings > Inference**.
2. In **Providers**, connect subscription accounts through the displayed OAuth/device flow or add API/local credentials. OpenAI/Codex uses the remote-safe device flow at `auth.openai.com/codex/device`; Gateway never relies on the Codex CLI's `localhost:1455` loopback callback. Subscription connectors are unofficial upstream integrations and require explicit terms/risk acknowledgement.
3. Wait for sync. Each connected account/key appears as its own row. Open a row to review 5h/7d/30d subscription quota, enable or disable it, synchronize it manually, or configure a minimum remaining reserve.
4. Gateway automatically routes across compatible accounts for the same provider/model while retaining thread affinity and failing over only before client output begins. A subscription connection is excluded when its worst fresh quota window falls below its configured reserve.
5. In **Models**, publish a stable public model ID for one provider and upstream model.
6. Configure context/input/output/auto-compaction limits, modalities, access, subscription multiplier, and versioned API pricing.
7. Configure reasoning overrides such as `ultra=max`. Efforts without an override map to the same provider name.
8. In **Settings > Inference > Limits**, set default limits and optional per-user overrides.

There is no user-visible or administrator-managed Pool entity. One logical model belongs to one provider template and one upstream model; Gateway does not mix providers behind a model.

## User setup

Users need `feat:ai:use`, which grants both AI Workspace and Gateway Inference access, including personal usage visibility. Token creation and revocation additionally require `inference:tokens:manage`.

Create a token under **Profile > Authorizations > Inference API tokens**. The `gwi_` secret is shown once.

Use the client-specific base URL:

```text
OpenAI SDK baseURL:   https://gateway.example.com/api/inference/v1
Codex CLI base URL:   https://gateway.example.com/api/inference/codex/v1
Anthropic SDK baseURL: https://gateway.example.com/api/inference/anthropic
API key:              gwi_...
```

The base `/api/inference/v1` adapter is always available while inference is enabled and exposes the OpenAI-compatible Models, Responses, Chat Completions, images, search, and realtime surfaces. Harness-specific adapters are disabled by default and can be enabled in **Settings > Inference**. When enabled, Codex exposes its ModelInfo catalog, Responses, and Responses Compact under `/api/inference/codex/v1`; Anthropic's REST endpoints live under `/api/inference/anthropic/v1`, while its SDK `baseURL` omits `/v1` because the SDK adds that segment itself.

For Codex and Claude Code, prefer the companion package instead of editing configuration or copying tokens manually:

```bash
npx -y @wiolett/gateway-inference@latest
```

The interactive package asks for the Gateway URL, completes resource-isolated OAuth with PKCE, and offers each harness advertised by Gateway. Direct `login [gateway]`, `logout`, and `setup [harness]` commands are also available:

```bash
npx -y @wiolett/gateway-inference@latest setup codex
npx -y @wiolett/gateway-inference@latest setup claude-code
```

Codex setup issues a dedicated runtime token, installs a private stable helper and loopback proxy, and maintains the authoritative Gateway model catalog. Codex Desktop must also be signed in to an OpenAI account through its normal login flow; after setup or login changes, fully quit and reopen Codex so it reloads the custom model catalog.

Claude Code setup requires Claude Code 2.1.129 or newer. It configures Claude Code's native Anthropic gateway contract through `ANTHROPIC_BASE_URL`, model discovery, and a private `apiKeyHelper`; it does not run a loopback proxy. The integration applies only to the Claude Code CLI, not Claude Desktop or the VS Code extension.

Enable **Harness-specific endpoints** in **Settings > Inference** before running either setup. Gateway displays a risk acknowledgement because harness APIs are alpha integrations that can change upstream and may stop working after a harness update. The base OpenAI-compatible adapter does not require this toggle. The package does not require a global install or modify `PATH`.

For ChatGPT subscription-backed models whose upstream catalog advertises it, Codex also exposes `/fast`. Gateway forwards the `priority` service tier and charges a fixed 2x subscription-credit multiplier; API dollar accounting is unchanged.

Supported primary operations across those adapters include:

- `GET /models`
- `POST /responses`
- `POST /responses/compact`
- `POST /chat/completions`
- `POST /messages`
- `POST /messages/count_tokens`
- `POST /images/generations`
- `POST /images/edits`
- `POST /alpha/search`
- `POST /realtime/calls` and `POST /live`

Responses, Chat Completions, and Messages support unary and SSE responses. Responses also supports its WebSocket transport. Authentication accepts only a dedicated `gwi_` token through `Authorization: Bearer` or `x-api-key`; browser sessions and regular `gw_`/`gwo_` credentials cannot enter the data plane.

## Limits and accounting

Users see percentages only:

- monthly API usage;
- shared subscription usage for rolling 5-hour, 7-day, and 30-day windows;
- recovery/reset timestamps.

Administrators can see raw cost, tokens, credits, upstream quota, and request metadata.

Setting a user's monthly API budget to zero disables API-funded usage for that user. Logical models whose usable sources are API-only are then omitted from the base OpenAI catalog, harness-specific catalogs, and the AI Workspace model picker instead of being shown as unusable choices.

Subscription credits use:

```text
tokens / 1000 × logical-or-source model multiplier × frozen dynamic burn multiplier × frozen service-tier multiplier
```

Dynamic burn protects upstream quota with a 30% reserve, a 10% new-thread floor, a 3% emergency floor, and an 8x cap. The multiplier is frozen at admission. Codex Fast adds a separate fixed 2x service-tier multiplier for eligible ChatGPT subscription sources.

The final 5% of each subscription limit is excluded from the user-visible chat budget and reserved for recovery. When a full conservative output reservation no longer fits, Gateway reduces the admitted `maxOutputTokens` to the remaining budget. A final request may borrow at most 1% of the configured limit, leaving at least 4% protected for compaction. Compaction uses a 1x dynamic burn, retains the requested Fast multiplier, and may consume the protected reserve.

API usage is stored in integer microdollars using the pricing snapshot selected at admission. Redis holds atomic reservations, affinity, cooldowns, refresh locks, and bounded encrypted continuation state; PostgreSQL remains the source of truth and stores immutable settlement ledger rows.

## Compaction and continuation

Gateway supports:

- `previous_response_id` continuation, isolated to the owning user;
- the v1 `/responses/compact` replacement-history response;
- the Responses v2 `compaction_trigger` item;
- Gateway `ocx1:` compaction envelopes that can be passed back as a `compaction` input item.

Compaction is accounted separately and never receives dynamic burn; a requested eligible Fast tier still receives its fixed service-tier multiplier. Provider selection cannot change after output begins, preventing mixed or duplicated streams.

## Security and privacy

- Provider credentials are encrypted with the Gateway master key and never returned by management APIs.
- Generic/private upstream URLs are denied by default. An administrator must explicitly allow a private destination; URL credentials, metadata/link-local/multicast destinations, unsafe schemes, and redirects are rejected.
- OAuth state, PKCE verifiers, refresh tokens, and continuation state are encrypted and bounded.
- Activity and logs store metadata and normalized usage only, never prompts or model output.
- Structured runtime logs use request IDs, logical model/provider/source type, latency, usage, burn, status, and error code. They do not label users or provider accounts.

## Operations

Monitor **Settings > Inference > Overview/Activity** for request/error rate, tokens, cost, account health, quota freshness, reauthentication, estimated usage, and routing failures. Alert operationally on repeated `provider_reauth_required`, `provider_rate_limited`, `provider_unavailable`, stale quota, reservation/reconciliation errors, and unexpected estimated usage.

Back up the PostgreSQL inference tables with the normal database backup and preserve the encryption master key. Redis continuation/reservation state is intentionally recoverable or short-lived; the reconciliation job repairs reservation drift from PostgreSQL.

To disable inference:

1. Turn off **Settings > General > General settings > Inference**. The change applies immediately.
2. Revoke routing/user scopes or individual `gwi_` tokens if required.
3. Keep provider credentials and immutable accounting/audit rows unless an administrator explicitly disconnects a provider.
4. Do not delete inference tables as part of rollback.

## Verification and staging checklist

CI and local development use the deterministic, secret-free emulator in `packages/backend/src/modules/inference/testing`. It covers model discovery, Responses/Chat/Messages streams, tools, reasoning, missing usage, quota/balance, OAuth refresh, images/search/realtime, delay, disconnect, partial output, and 401/429/5xx failures.

Before enabling production scopes, verify in staging with at least one real subscription and one real API connector:

- OAuth/API credential lifecycle and reauthentication;
- real model/quota discovery and freshness;
- published model access and reasoning mapping;
- subscription request, quota pressure, and automatic API fallback;
- user percentage update and administrator raw accounting;
- Codex discovery, streaming, tools, reasoning, continuation, and explicit auto-compaction;
- Claude Messages streaming and `count_tokens`;
- OpenAI Chat Completions client;
- disable/re-enable rollback without deleting ledger or credentials.

Never put staging credentials or prompts in CI artifacts.
