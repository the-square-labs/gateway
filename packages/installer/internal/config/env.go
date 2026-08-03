package config

import "os"

func Env(name string) string { return os.Getenv(name) }

func BoolEnv(name string, fallback bool) bool {
	v := Env(name)
	if v == "" {
		return fallback
	}
	switch v {
	case "1", "true", "TRUE", "yes", "YES", "y", "Y":
		return true
	case "0", "false", "FALSE", "no", "NO", "n", "N":
		return false
	}
	return fallback
}

func NodeFromEnvironment() Node {
	return Node{
		Gateway: Env("GATEWAY_NODE_ADDRESS"), Host: Env("GATEWAY_NODE_HOST"), Port: Env("GATEWAY_NODE_PORT"), Token: Env("GATEWAY_NODE_TOKEN"), GatewayCertSHA256: Env("GATEWAY_NODE_CERT_SHA256"), Version: Env("GATEWAY_NODE_DAEMON_VERSION"), NginxMode: Env("GATEWAY_NODE_NGINX_MODE"), GitLabURL: Env("GATEWAY_GITLAB_URL"), GitLabProject: Env("GATEWAY_GITLAB_PROJECT"), DatabaseStorageRoot: Env("GATEWAY_DATABASE_STORAGE_ROOT"), SkipNginx: BoolEnv("GATEWAY_NODE_SKIP_NGINX", false),
	}
}

func GatewayFromEnvironment() Gateway {
	return Gateway{
		Version: Env("GATEWAY_VERSION"), Image: Env("GATEWAY_IMAGE"), GitLabURL: Env("GITLAB_API_URL"), GitLabProject: Env("GITLAB_PROJECT_PATH"), Domain: Env("GATEWAY_DOMAIN"), ACMEEmail: Env("GATEWAY_ACME_EMAIL"), OIDCIssuer: Env("GATEWAY_OIDC_ISSUER"), OIDCClientID: Env("GATEWAY_OIDC_CLIENT_ID"), OIDCClientSecret: Env("GATEWAY_OIDC_CLIENT_SECRET"), OIDCRedirectURI: Env("GATEWAY_OIDC_REDIRECT_URI"), AuthMethods: Env("GATEWAY_AUTH_METHODS"), SMTPHost: Env("GATEWAY_SMTP_HOST"), SMTPPort: Env("GATEWAY_SMTP_PORT"), SMTPTLSMode: Env("GATEWAY_SMTP_TLS_MODE"), SMTPUsername: Env("GATEWAY_SMTP_USERNAME"), SMTPPassword: Env("GATEWAY_SMTP_PASSWORD"), SMTPSenderName: Env("GATEWAY_SMTP_SENDER_NAME"), SMTPSenderEmail: Env("GATEWAY_SMTP_SENDER_EMAIL"), InitialAdminEmail: Env("GATEWAY_INITIAL_ADMIN_EMAIL"), InitialAdminName: Env("GATEWAY_INITIAL_ADMIN_NAME"), InitialAdminMethod: Env("GATEWAY_INITIAL_ADMIN_METHOD"), InitialAdminPassword: Env("GATEWAY_INITIAL_ADMIN_PASSWORD"), ACMEStaging: BoolEnv("GATEWAY_ACME_STAGING", false), SSLCert: Env("GATEWAY_SSL_CERT"), SSLKey: Env("GATEWAY_SSL_KEY"), SSLChain: Env("GATEWAY_SSL_CHAIN"), ResourceProfile: Env("GATEWAY_RESOURCE_PROFILE"), DatabaseMode: Env("GATEWAY_DATABASE_MODE"), DatabaseURL: Env("GATEWAY_DATABASE_URL"), LoggingMode: Env("GATEWAY_LOGGING_MODE"), ClickHouseURL: Env("GATEWAY_CLICKHOUSE_URL"), ClickHouseUsername: Env("GATEWAY_CLICKHOUSE_USERNAME"), ClickHousePassword: Env("GATEWAY_CLICKHOUSE_PASSWORD"), ClickHouseDatabase: Env("GATEWAY_CLICKHOUSE_DATABASE"), ClickHouseTable: Env("GATEWAY_CLICKHOUSE_LOGS_TABLE"), LogMaxSize: Env("GATEWAY_LOG_MAX_SIZE"), LogMaxFile: Env("GATEWAY_LOG_MAX_FILE"), LogRotation: BoolEnv("GATEWAY_LOG_ROTATION", true), RestrictEnv: BoolEnv("GATEWAY_RESTRICT_ENV", true), NginxVersion: Env("GATEWAY_NGINX_VERSION"), SkipStart: BoolEnv("GATEWAY_SKIP_START", false),
	}
}
