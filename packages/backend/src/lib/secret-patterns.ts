/**
 * Shapes of secret material that Gateway recognizes in free text: the idempotency store refuses to keep results that
 * carry them, and diagnostics logs and AI tool results mask them. Non-global, so `test` is stateless; build a global
 * copy (`new RegExp(pattern.source, 'g')`) to replace.
 */

/** A Gateway-issued token: `gw_`, `gwo_`, `gwl_`, `gwr_`, `gwpu_` … followed by its random part. */
export const GATEWAY_TOKEN_PATTERN = /\bgw[a-z]{0,3}_[A-Za-z0-9_-]{16,}/;

/** The header of a PEM private key block. */
export const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
