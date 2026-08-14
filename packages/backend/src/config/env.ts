import { z } from 'zod';

// Development only. Production database bindings require a registry image
// pinned by manifest digest.
export const DEVELOPMENT_DATABASE_CONNECTOR_IMAGE = 'gateway-database-connector:dev';
export const DEVELOPMENT_SECURE_LINK_CONNECTOR_IMAGE = 'gateway-secure-link-connector:dev';
const IMMUTABLE_CONNECTOR_IMAGE_PATTERN = /^.+@sha256:[0-9a-f]{64}$/i;

const rateLimitWindowSchema = z.coerce.number().int().positive();
const rateLimitMaxSchema = z.coerce.number().int().positive();
const optionalClickHouseUrlSchema = z
  .string()
  .optional()
  .default('')
  .refine((value) => value === '' || z.string().url().safeParse(value).success, {
    message: 'CLICKHOUSE_URL must be a URL when provided',
  });
const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().optional()
);
const nonEmptyStringWithDefault = (fallback: string) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().optional().default(fallback)
  );

const envSchema = z.object({
  // Server
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Database
  DATABASE_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().url(),

  // Optional external logging storage
  CLICKHOUSE_URL: optionalClickHouseUrlSchema,
  CLICKHOUSE_USERNAME: z.string().default('default'),
  CLICKHOUSE_PASSWORD: z.string().default(''),
  CLICKHOUSE_DATABASE: z.string().default('gateway_logs'),
  CLICKHOUSE_LOGS_TABLE: z.string().default('logs'),
  CLICKHOUSE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  // External logging ingest guardrails
  LOGGING_INGEST_MAX_BODY_BYTES: z.coerce.number().int().positive().default(1_048_576),
  LOGGING_INGEST_MAX_BATCH_SIZE: z.coerce.number().int().positive().default(500),
  LOGGING_INGEST_MAX_MESSAGE_BYTES: z.coerce.number().int().positive().default(16_384),
  LOGGING_INGEST_MAX_LABELS: z.coerce.number().int().positive().default(32),
  LOGGING_INGEST_MAX_FIELDS: z.coerce.number().int().positive().default(64),
  LOGGING_INGEST_MAX_KEY_LENGTH: z.coerce.number().int().positive().default(100),
  LOGGING_INGEST_MAX_VALUE_BYTES: z.coerce.number().int().positive().default(8192),
  LOGGING_INGEST_MAX_JSON_DEPTH: z.coerce.number().int().positive().default(5),
  LOGGING_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  LOGGING_GLOBAL_REQUESTS_PER_WINDOW: z.coerce.number().int().positive().default(600),
  LOGGING_GLOBAL_EVENTS_PER_WINDOW: z.coerce.number().int().positive().default(60_000),
  LOGGING_TOKEN_REQUESTS_PER_WINDOW: z.coerce.number().int().positive().default(300),
  LOGGING_TOKEN_EVENTS_PER_WINDOW: z.coerce.number().int().positive().default(10_000),

  // OIDC
  OIDC_ISSUER: optionalNonEmptyString.refine((value) => !value || z.string().url().safeParse(value).success, {
    message: 'OIDC_ISSUER must be a URL when provided',
  }),
  OIDC_CLIENT_ID: optionalNonEmptyString,
  OIDC_CLIENT_SECRET: optionalNonEmptyString,
  OIDC_REDIRECT_URI: optionalNonEmptyString.refine((value) => !value || z.string().url().safeParse(value).success, {
    message: 'OIDC_REDIRECT_URI must be a URL when provided',
  }),
  OIDC_SCOPES: z.string().default('openid email profile'),

  // Public OAuth App client used by every Gateway installation for GitHub Device Flow.
  // Device Flow does not use a client secret or a per-instance callback URL.
  GITHUB_OAUTH_CLIENT_ID: optionalNonEmptyString,

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: rateLimitWindowSchema.default(60000),
  RATE_LIMIT_MAX_REQUESTS: rateLimitMaxSchema.default(1200),
  RATE_LIMIT_AUTH_MAX_REQUESTS: rateLimitMaxSchema.default(120),
  RATE_LIMIT_AUTH_LOGIN_MAX_REQUESTS: rateLimitMaxSchema.default(20),
  RATE_LIMIT_AUTH_CALLBACK_MAX_REQUESTS: rateLimitMaxSchema.default(60),
  RATE_LIMIT_SETUP_MAX_REQUESTS: rateLimitMaxSchema.default(20),
  RATE_LIMIT_PUBLIC_STATUS_MAX_REQUESTS: rateLimitMaxSchema.default(600),
  RATE_LIMIT_PUBLIC_WEBHOOK_MAX_REQUESTS: rateLimitMaxSchema.default(60),
  RATE_LIMIT_PKI_MAX_REQUESTS: rateLimitMaxSchema.default(600),
  RATE_LIMIT_STREAM_MAX_REQUESTS: rateLimitMaxSchema.default(120),
  RATE_LIMIT_AI_WS_MAX_REQUESTS: rateLimitMaxSchema.default(120),
  RATE_LIMIT_INFERENCE_MAX_REQUESTS: rateLimitMaxSchema.default(600),

  // Request body limits
  REQUEST_BODY_MAX_BYTES: z.coerce.number().int().positive().default(2_097_152),
  OAUTH_BODY_MAX_BYTES: z.coerce.number().int().positive().default(32_768),
  DOCKER_FILE_WRITE_MAX_BODY_BYTES: z.coerce.number().int().positive().default(150_000_000),
  INFERENCE_BODY_MAX_BYTES: z.coerce.number().int().positive().default(33_554_432),
  INFERENCE_MAX_CONCURRENT_REQUESTS_PER_TOKEN: z.coerce.number().int().positive().default(16),
  INFERENCE_CONCURRENCY_LEASE_SECONDS: z.coerce.number().int().positive().default(600),
  INFERENCE_CONTINUATION_MAX_BYTES: z.coerce.number().int().positive().default(2_097_152),
  INFERENCE_CONTINUATION_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),

  // Session
  SESSION_EXPIRY: z.coerce.number().default(2592000), // 30 days

  // App
  APP_URL: z.string().url().default('http://localhost:3000'),
  APP_VERSION: z.string().default('dev'),
  BIND_HOST: z.string().default('0.0.0.0'),
  GATEWAY_LOCAL_HOSTS: z.string().optional(),
  WEB_TLS_BOOTSTRAP_MODE: z.enum(['http', 'https']).optional(),
  WEB_TLS_AUTO_DIR: nonEmptyStringWithDefault('/var/lib/gateway/tls'),

  // First-party TCP connector for managed database bindings. Production must
  // provide an immutable release reference; development receives the fixed
  // local image after parsing below.
  DATABASE_CONNECTOR_IMAGE: z.string().trim().default(''),
  SECURE_LINK_CONNECTOR_IMAGE: z.string().trim().default(''),

  // Compose project dir (for self-update sidecar)
  COMPOSE_PROJECT_DIR: z.string().optional(),

  // Updates
  GITLAB_API_URL: z.string().default('https://gitlab.wiolett.net'),
  GITLAB_PROJECT_PATH: z.string().default('wiolett/gateway'),
  UPDATE_CHECK_INTERVAL_HOURS: z.coerce.number().default(4),

  // PKI Master Key — 32 bytes as 64-char hex string for envelope encryption
  PKI_MASTER_KEY: z
    .string()
    .length(64)
    .regex(/^[0-9a-fA-F]+$/),

  // PKI defaults
  DEFAULT_CRL_VALIDITY_HOURS: z.coerce.number().default(24),
  DEFAULT_OCSP_VALIDITY_MINUTES: z.coerce.number().default(60),
  EXPIRY_WARNING_DAYS: z.coerce.number().default(30),
  EXPIRY_CRITICAL_DAYS: z.coerce.number().default(7),

  // ACME
  ACME_EMAIL: z.string().email().optional(),
  ACME_STAGING: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  // DNS / Domains
  PUBLIC_IPV4: z.string().optional(),
  PUBLIC_IPV6: z.string().optional(),
  DNS_RESOLVERS: z.string().default('8.8.8.8,1.1.1.1'),
  DNS_CHECK_INTERVAL_SECONDS: z.coerce.number().default(300),

  // Background Jobs
  HEALTH_CHECK_INTERVAL_SECONDS: z.coerce.number().default(30),
  ACME_RENEWAL_CRON: z.string().default('0 3 * * *'), // 3 AM daily
  EXPIRY_CHECK_CRON: z.string().default('0 6 * * *'), // 6 AM daily

  SETUP_BOOTSTRAP: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  // gRPC server for daemon communication
  GRPC_PORT: z.coerce.number().default(9443),
  GRPC_TLS_CERT: optionalNonEmptyString,
  GRPC_TLS_KEY: optionalNonEmptyString,
  GRPC_TLS_AUTO_DIR: nonEmptyStringWithDefault('/var/lib/gateway/tls'),
  GATEWAY_RELAY_IDENTITY_DIR: nonEmptyStringWithDefault('/var/lib/gateway-relay'),
  GATEWAY_RELAY_TARGET: nonEmptyStringWithDefault('relay:9443'),
  GATEWAY_RELAY_REQUIRED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  GATEWAY_RELAY_MANAGED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  GATEWAY_RELAY_IMAGE_REF: optionalNonEmptyString,
  GATEWAY_RELAY_SERVICE_NAME: nonEmptyStringWithDefault('relay'),
  GATEWAY_RELAY_BUILD_VERSION: optionalNonEmptyString,
  GATEWAY_RELAY_PROTOCOL_MAJOR: z.coerce.number().int().positive().default(1),

  // AI sandbox artifacts
  AI_SANDBOX_ARTIFACT_DIR: nonEmptyStringWithDefault('/var/lib/gateway/ai-artifacts'),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (cachedEnv) {
    return cachedEnv;
  }

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment variables:');
    console.error(result.error.format());
    throw new Error('Invalid environment variables');
  }

  const parsedEnv = result.data;
  if (
    parsedEnv.NODE_ENV === 'production' &&
    parsedEnv.SECURE_LINK_CONNECTOR_IMAGE &&
    !IMMUTABLE_CONNECTOR_IMAGE_PATTERN.test(parsedEnv.SECURE_LINK_CONNECTOR_IMAGE)
  ) {
    throw new Error('SECURE_LINK_CONNECTOR_IMAGE must use an immutable sha256 digest in production');
  }
  cachedEnv = parsedEnv;
  if (cachedEnv.NODE_ENV === 'development' && !cachedEnv.DATABASE_CONNECTOR_IMAGE) {
    cachedEnv.DATABASE_CONNECTOR_IMAGE = DEVELOPMENT_DATABASE_CONNECTOR_IMAGE;
  }
  if (cachedEnv.NODE_ENV === 'development' && !cachedEnv.SECURE_LINK_CONNECTOR_IMAGE) {
    cachedEnv.SECURE_LINK_CONNECTOR_IMAGE = DEVELOPMENT_SECURE_LINK_CONNECTOR_IMAGE;
  }
  return cachedEnv;
}

export function isDevelopment(): boolean {
  return getEnv().NODE_ENV === 'development';
}

export function isProduction(): boolean {
  return getEnv().NODE_ENV === 'production';
}

export function isTest(): boolean {
  return getEnv().NODE_ENV === 'test';
}
