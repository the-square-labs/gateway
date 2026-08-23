# Multi-provider inference proxy

Gateway exposes a standalone OpenAI- and Anthropic-compatible inference data plane. It is isolated from AI Workspace and the MCP runtime: it uses dedicated provider credentials, `gwi_` user tokens, model access rules, accounting, and a usage ledger.

The data plane is served by a managed OpenCodex inference core that Gateway installs and updates on the host as a supervised container. Gateway remains the control plane: provider connections, models, limits, tokens, pricing, and accounting stay in the Gateway UI and database, and are delegated to the core automatically. The connector baseline is OpenCodex; Cursor, Kiro, and OpenCodex desktop lifecycle features are intentionally excluded.

The provider registry covers OpenAI/Codex, Anthropic, xAI, Kimi/Moonshot, Google Gemini, Google Antigravity, GitHub Copilot, Umans, OpenCode, NeuralWatt, OrcaRouter, DeepSeek, Fire Pass, NVIDIA, Z.AI, SiliconFlow, Qwen, Tencent, Alibaba, ZenMux, LiteLLM, Ollama, vLLM, LM Studio, MiniMax, MiMo, Cloudflare Workers AI, OpenRouter, Groq, Cerebras, Together, Hugging Face, Mistral, Azure OpenAI, and generic OpenAI-compatible endpoints. Google Antigravity uses Cloud Code Assist project discovery and its request envelope. Provider-specific capabilities remain explicit in the registry, so an unavailable surface fails closed instead of silently using the wrong wire format.

## Enable inference

Inference is disabled by default. An administrator with Gateway settings access enables it under **Settings > General > General settings > Inference**. No process restart is required.

When disabled, management and data-plane routes return `INFERENCE_DISABLED`, and the frontend omits Inference usage, token management, and administration surfaces. Connected provider credentials, model configuration, and accounting history remain stored.

Apply database migrations before enabling the flag. Roll out admin scopes first, install the inference core, configure and verify providers/models, then grant `feat:ai:use` and token scopes to a limited user group.

## Inference core lifecycle

The managed core is a single `inference-core` container supervised by Gateway. It listens only on the internal Docker network; clients never reach it directly. All client traffic enters through Gateway's `/api/inference/v1` proxy, which authenticates the `gwi_` token, admits the request against budgets, and forwards it to the core with a signed per-request context. The core reports admission and settlement back to Gateway over an authenticated internal callback channel, so PostgreSQL remains the source of truth for usage and billing.

Administrators manage the core from **Settings > Inference** (and during initial setup from the setup wizard):

- **Install** downloads the pinned, signature-verified core release and starts the container.
- **Update** installs a newer signed release with automatic rollback to the previous working version if the new one fails health checks.
- **Repair** reconciles a degraded or failed container back to the desired state.
- **Check updates** records the newest release available on the channel.

Only one lifecycle operation runs at a time. Operations interrupted by a Gateway restart are marked failed and reconciled from observed container state on boot.

Gateway and inference-core upgrades do not invalidate provider connections, runtime tokens, or an installed harness integration. The companion helper refreshes the Codex model catalog automatically. Rerun `setup` only when repairing or replacing the local integration, changing Gateway identity, or adopting a future explicitly incompatible endpoint contract.

## Administrator setup

1. Open **Settings > Inference**.
2. Install the inference core and wait for it to report healthy.
3. In **Providers**, connect subscription accounts through the displayed OAuth/device flow or add API/local credentials. OpenAI/Codex uses the remote-safe device flow at `auth.openai.com/codex/device`; Gateway never relies on the Codex CLI's `localhost:1455` loopback callback. Subscription connectors are unofficial upstream integrations and require explicit terms/risk acknowledgement.
4. Wait for sync. Providers with multiple connected accounts/keys appear as one collapsible table group; a provider with one connection remains a normal row. Open an account row to review 5h/7d/30d subscription quota, enable or disable it, synchronize it manually, or configure a minimum remaining reserve.
5. Gateway automatically routes across compatible accounts for the same provider/model while retaining thread affinity and failing over only before client output begins. Within a provider group, drag account rows to set the priority used by Sequential routing; accounts cannot be moved between provider groups. A subscription connection is excluded when its worst fresh quota window falls below its configured reserve.
6. In **Models**, publish a stable public model ID for one provider and upstream model.
7. Configure context/input/output/auto-compaction limits, modalities, and access. Subscription-backed models also have a credit multiplier; API-backed models use versioned provider/manual pricing and do not expose a subscription multiplier.
8. Configure reasoning overrides such as `ultra=max`. Efforts without an override map to the same provider name. Drag efforts into the order that clients and the AI Workspace reasoning selector should display them.
9. In **Settings > Inference > Limits**, set default limits and optional per-user overrides.

Drag model rows to set the order returned by the management and data-plane catalogs. The companion preserves that order in the Codex manifest, and AI Workspace uses it for its model selector and default-model fallback.

There is no user-visible or administrator-managed Pool entity. One logical model belongs to one provider template and one upstream model; Gateway does not mix providers behind a model.

## User setup

Users need `feat:ai:use`, which grants both AI Workspace and Gateway Inference access, including personal usage visibility. Token creation and revocation additionally require `inference:tokens:manage`.

Create a token under **Profile > Authorizations > Inference API tokens**. The `gwi_` secret is shown once.

All clients use the single stable base URL:

```text
OpenAI SDK baseURL:    https://gateway.example.com/api/inference/v1
Anthropic SDK baseURL: https://gateway.example.com/api/inference
API key:               gwi_...
```

The `/api/inference/v1` endpoint exposes the OpenAI-compatible Models, Responses, Chat Completions, Anthropic Messages, images, search, and realtime surfaces. Anthropic SDKs append `/v1` themselves, so their `baseURL` omits that segment.

For Codex and Claude Code, prefer the companion package instead of editing configuration or copying tokens manually:

```bash
npx -y @wiolett/gateway-inference@latest
```

The interactive package asks for the Gateway URL, completes resource-isolated OAuth with PKCE, and offers each supported harness. Direct `login [gateway]`, `logout`, and `setup [harness]` commands are also available:

```bash
npx -y @wiolett/gateway-inference@latest setup codex
npx -y @wiolett/gateway-inference@latest setup claude-code
```

Codex setup issues a dedicated runtime token, installs a private stable helper and loopback proxy, and maintains the authoritative Gateway model catalog. Codex Desktop must also be signed in to an OpenAI account through its normal login flow; after setup or login changes, fully quit and reopen Codex so it reloads the custom model catalog.

Claude Code setup requires Claude Code 2.1.129 or newer. It configures Claude Code's native Anthropic gateway contract through `ANTHROPIC_BASE_URL`, model discovery, and a private `apiKeyHelper`; it does not run a loopback proxy. The integration applies only to the Claude Code CLI, not Claude Desktop or the VS Code extension.

For ChatGPT subscription-backed models whose upstream catalog advertises it, Codex also exposes `/fast`. Gateway forwards the `priority` service tier and charges a fixed 2x subscription-credit multiplier; API dollar accounting is unchanged.

Supported primary operations include:

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

Responses, Chat Completions, and Messages support unary and SSE responses. Responses also supports an end-to-end WebSocket transport: Gateway keeps the client socket open across turns, forwards each turn to the managed core over WebSocket, and issues fresh signed admission context per turn without converting the stream through SSE or disk files. Realtime sideband/audio WebSockets are intentionally excluded from this release. Authentication accepts only a dedicated `gwi_` token through `Authorization: Bearer` or `x-api-key`; browser sessions and regular `gw_`/`gwo_` credentials cannot enter the data plane.

## Limits and accounting

Users see percentages only:

- monthly API usage;
- shared subscription usage for rolling 5-hour, 7-day, and 30-day windows;
- recovery/reset timestamps.

Administrators can see raw cost, tokens, credits, upstream quota, and request metadata.

Setting a user's monthly API budget to zero disables API-funded usage for that user. Logical models whose usable sources are API-only are then omitted from the OpenAI-compatible catalog and the AI Workspace model picker instead of being shown as unusable choices.

Settled subscription credits use weighted token classes:

```text
weighted tokens =
    uncached input
  + cached input × 0.10
  + cache write × 1.25
  + output
  + reasoning

credits = weighted tokens / 1000
  × model multiplier
  × frozen dynamic burn multiplier
  × frozen service-tier multiplier
```

Admission first reserves a conservative input-plus-output estimate without assuming a future cache hit; settlement replaces it with the weighted actual usage above. Dynamic burn compares remaining quota with the fraction of time left in each reported window, enforces a 30% quota-pressure floor, and caps the result at 8x. Stale, exhausted, or invalid quota data fails closed at 8x. The multiplier is frozen at admission. Codex Fast adds a separate fixed 2x service-tier multiplier for eligible ChatGPT subscription sources; API dollar accounting is unaffected.

The final 5% of each subscription limit is excluded from the user-visible chat budget and reserved for recovery. When a full conservative output reservation no longer fits, Gateway reduces the admitted `maxOutputTokens` to the remaining budget. A final request may borrow at most 1% of the configured limit, leaving at least 4% protected for compaction. Compaction uses a 1x dynamic burn, retains the requested Fast multiplier, and may consume the protected reserve.

API usage is stored in integer microdollars using the pricing snapshot selected at admission. API-backed models do not consume subscription credits or use a subscription multiplier. Redis holds atomic reservations, affinity, cooldowns, and refresh locks; PostgreSQL remains the source of truth and stores immutable settlement ledger rows. Continuation state lives in the managed core rather than being duplicated in Gateway request-history storage.

## Compaction and continuation

Gateway supports:

- `previous_response_id` continuation, isolated to the owning user;
- the v1 `/responses/compact` replacement-history response;
- the Responses v2 `compaction_trigger` item;
- Gateway `ocx1:` compaction envelopes that can be passed back as a `compaction` input item.

Compaction is accounted separately and never receives dynamic burn; a requested eligible Fast tier still receives its fixed service-tier multiplier. Provider selection cannot change after output begins, preventing mixed or duplicated streams.

For Responses WebSocket clients, the socket remains usable until the client, Gateway, or the managed core closes it. A failed or incomplete turn is recorded as failed instead of being finalized as a successful zero-output request. Activity stores normalized metadata and usage only; hovering a model in the administrator activity table identifies the provider account used for that request.

## Security and privacy

- Provider credentials are encrypted with the Gateway master key and never returned by management APIs.
- Generic/private upstream URLs are denied by default. An administrator must explicitly allow a private destination; URL credentials, metadata/link-local/multicast destinations, unsafe schemes, and redirects are rejected.
- OAuth state, PKCE verifiers, and refresh tokens are encrypted and bounded.
- The core container is reachable only from Gateway over the internal Docker network; the core callback channel is authenticated with per-request signed contexts.
- Activity and logs store metadata and normalized usage only, never prompts or model output.
- Structured runtime logs use request IDs, logical model/provider/source type, latency, usage, burn, status, and error code. They do not label users or provider accounts.

## Operations

Monitor **Settings > Inference > Overview/Activity** for request/error rate, tokens, cost, account health, quota freshness, reauthentication, estimated usage, and routing failures. Alert operationally on repeated `provider_reauth_required`, `provider_rate_limited`, `provider_unavailable`, stale quota, reservation/reconciliation errors, and unexpected estimated usage.

Back up the PostgreSQL inference tables with the normal database backup and preserve the encryption master key. Redis reservation state is intentionally recoverable or short-lived; the reconciliation job repairs reservation drift from PostgreSQL. Core release artifacts and container state are re-downloadable from the signed release channel and do not need backup.

Troubleshooting:

- Core unhealthy or missing: use **Repair** in **Settings > Inference**; check the lifecycle operation log shown there for the failing step.
- A broken local Codex/Claude Code integration after an upgrade: run the companion manager's diagnose/repair flow; rerun `setup` only if the package-managed integration itself must be replaced.
- A failed core update rolls back automatically; if rollback also fails, **Repair** reinstalls the last known-good pinned release.

To disable inference:

1. Turn off **Settings > General > General settings > Inference**. The change applies immediately.
2. Revoke routing/user scopes or individual `gwi_` tokens if required.
3. Keep provider credentials and immutable accounting/audit rows unless an administrator explicitly disconnects a provider.
4. Do not delete inference tables as part of rollback.

## Verification and staging checklist

CI and local development use the deterministic, secret-free emulator in `packages/backend/src/modules/inference/testing`. It covers model discovery, Responses/Chat/Messages streams, tools, reasoning, missing usage, quota/balance, OAuth refresh, images/search/realtime, delay, disconnect, partial output, and 401/429/5xx failures.

Before enabling production scopes, verify in staging with at least one real subscription and one real API connector:

- core install, update with rollback, and repair;
- OAuth/API credential lifecycle and reauthentication;
- real model/quota discovery and freshness;
- published model access and reasoning mapping;
- subscription request, quota pressure, and pre-output failover between eligible accounts of the same provider/model;
- user percentage update and administrator raw accounting;
- Codex discovery, streaming, tools, reasoning, continuation, and explicit auto-compaction;
- Claude Messages streaming and `count_tokens`;
- OpenAI Chat Completions client;
- disable/re-enable rollback without deleting ledger or credentials.

Never put staging credentials or prompts in CI artifacts.
