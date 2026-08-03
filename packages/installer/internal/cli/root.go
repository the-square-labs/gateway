package cli

import (
	"fmt"
	"os"

	"charm.land/huh/v2"
	"github.com/spf13/cobra"
	"github.com/wiolett-industries/gateway/installer/internal/config"
	"github.com/wiolett-industries/gateway/installer/internal/install"
)

func NewRootCommand(version string, _ []string) *cobra.Command {
	root := &cobra.Command{
		Use:           "gateway-installer",
		Short:         "Install and configure Wiolett Gateway and managed nodes",
		Version:       version,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !isInteractive() {
				return fmt.Errorf("choose install gateway or install node; use --help for commands")
			}
			return runInteractiveManager(cmd)
		},
	}
	root.SetFlagErrorFunc(func(_ *cobra.Command, err error) error { return fmt.Errorf("%w; use --help for usage", err) })
	installCommand := &cobra.Command{Use: "install", Short: "Run an installation workflow"}
	installCommand.AddCommand(newGatewayCommand(), newNodeCommand())
	root.AddCommand(installCommand)
	return root
}

func newGatewayCommand() *cobra.Command {
	g := config.GatewayFromEnvironment()
	cmd := &cobra.Command{
		Use:   "gateway",
		Short: "Install the Gateway control plane",
		RunE: func(cmd *cobra.Command, _ []string) error {
			g.Normalize()
			if !g.NonInteractive && isInteractive() {
				if err := promptGateway(&g); err != nil {
					return err
				}
			}
			return install.NewGateway(os.Stdout, os.Stderr).Run(cmd.Context(), g)
		},
	}
	f := cmd.Flags()
	f.StringVarP(&g.Version, "version", "v", g.Version, "Gateway image version (default: latest)")
	f.StringVar(&g.Image, "image", g.Image, "Gateway container image")
	f.StringVar(&g.GitLabURL, "gitlab-url", g.GitLabURL, "GitLab instance URL")
	f.StringVar(&g.GitLabProject, "gitlab-project", g.GitLabProject, "GitLab project path")
	f.StringVar(&g.Domain, "domain", g.Domain, "Gateway public domain")
	f.StringVar(&g.ACMEEmail, "acme-email", g.ACMEEmail, "ACME account email")
	f.StringVar(&g.OIDCIssuer, "oidc-issuer", g.OIDCIssuer, "OIDC issuer URL")
	f.StringVar(&g.OIDCClientID, "oidc-client-id", g.OIDCClientID, "OIDC client ID")
	f.StringVar(&g.OIDCClientSecret, "oidc-client-secret", g.OIDCClientSecret, "OIDC client secret")
	f.StringVar(&g.OIDCRedirectURI, "oidc-redirect-uri", g.OIDCRedirectURI, "OIDC callback URL")
	f.StringVar(&g.AuthMethods, "auth-methods", g.AuthMethods, "Authentication methods: oidc,password,emailOtp")
	f.StringVar(&g.SMTPHost, "smtp-host", g.SMTPHost, "SMTP host")
	f.StringVar(&g.SMTPPort, "smtp-port", g.SMTPPort, "SMTP port")
	f.StringVar(&g.SMTPTLSMode, "smtp-tls-mode", g.SMTPTLSMode, "SMTP TLS mode: starttls or tls")
	f.StringVar(&g.SMTPUsername, "smtp-username", g.SMTPUsername, "SMTP username")
	f.StringVar(&g.SMTPPassword, "smtp-password", g.SMTPPassword, "SMTP password")
	f.StringVar(&g.SMTPSenderName, "smtp-sender-name", g.SMTPSenderName, "SMTP sender name")
	f.StringVar(&g.SMTPSenderEmail, "smtp-sender-email", g.SMTPSenderEmail, "SMTP sender email")
	f.StringVar(&g.InitialAdminEmail, "initial-admin-email", g.InitialAdminEmail, "Initial administrator email")
	f.StringVar(&g.InitialAdminName, "initial-admin-name", g.InitialAdminName, "Initial administrator display name")
	f.StringVar(&g.InitialAdminMethod, "initial-admin-method", g.InitialAdminMethod, "Initial administrator auth method")
	f.StringVar(&g.InitialAdminPassword, "initial-admin-password", g.InitialAdminPassword, "Initial administrator password")
	f.BoolVar(&g.ACMEStaging, "acme-staging", g.ACMEStaging, "Use ACME staging")
	f.StringVar(&g.SSLCert, "ssl-cert", g.SSLCert, "Custom certificate PEM path")
	f.StringVar(&g.SSLKey, "ssl-key", g.SSLKey, "Custom private key PEM path")
	f.StringVar(&g.SSLChain, "ssl-chain", g.SSLChain, "Custom certificate chain PEM path")
	f.StringVar(&g.ResourceProfile, "resource-profile", g.ResourceProfile, "Resource profile: small, medium, large, custom")
	f.StringVar(&g.DatabaseURL, "database-url", g.DatabaseURL, "Remote PostgreSQL URL")
	f.StringVar(&g.LoggingMode, "logging-mode", g.LoggingMode, "Logging mode: local, remote, disabled")
	f.StringVar(&g.ClickHouseURL, "clickhouse-url", g.ClickHouseURL, "Remote ClickHouse URL")
	f.StringVar(&g.ClickHouseUsername, "clickhouse-username", g.ClickHouseUsername, "Remote ClickHouse username")
	f.StringVar(&g.ClickHousePassword, "clickhouse-password", g.ClickHousePassword, "Remote ClickHouse password")
	f.StringVar(&g.ClickHouseDatabase, "clickhouse-database", g.ClickHouseDatabase, "Remote ClickHouse database")
	f.StringVar(&g.ClickHouseTable, "clickhouse-table", g.ClickHouseTable, "Remote ClickHouse table")
	f.StringVar(&g.LogMaxSize, "log-max-size", g.LogMaxSize, "Docker log max size")
	f.StringVar(&g.LogMaxFile, "log-max-file", g.LogMaxFile, "Docker log max files")
	f.BoolVar(&g.SkipStart, "skip-start", g.SkipStart, "Generate files but do not start services")
	f.BoolVarP(&g.NonInteractive, "non-interactive", "y", g.NonInteractive, "Do not prompt")
	f.BoolVar(&g.NoLogo, "no-logo", g.NoLogo, "Suppress banner")
	f.BoolVar(&g.LogRotation, "log-rotation", g.LogRotation, "Enable Docker log rotation")
	f.BoolVar(&g.RestrictEnv, "restrict-env", g.RestrictEnv, "Restrict .env permissions")
	f.Bool("remote-database", false, "Use remote PostgreSQL")
	f.Bool("disable-logging", false, "Disable structured logging")
	f.Bool("no-log-rotation", false, "Disable Docker log rotation")
	f.Bool("no-restrict-env", false, "Do not restrict .env permissions")
	f.StringVar(&g.NginxVersion, "nginx-version", g.NginxVersion, "Nginx package source")
	cmd.PreRunE = func(cmd *cobra.Command, _ []string) error {
		if cmd.Flags().Changed("remote-database") {
			g.DatabaseMode = "remote"
		}
		if g.DatabaseURL != "" {
			g.DatabaseMode = "remote"
		}
		if cmd.Flags().Changed("disable-logging") {
			g.LoggingMode = "disabled"
		}
		if cmd.Flags().Changed("no-log-rotation") {
			g.LogRotation = false
		}
		if cmd.Flags().Changed("no-restrict-env") {
			g.RestrictEnv = false
		}
		return nil
	}
	return cmd
}

func newNodeCommand() *cobra.Command {
	n := config.NodeFromEnvironment()
	cmd := &cobra.Command{
		Use:   "node",
		Short: "Install a Gateway managed node",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !n.Type.Valid() && !n.NonInteractive && isInteractive() {
				if err := chooseNodeType(&n); err != nil {
					return err
				}
			}
			n.Normalize()
			if !n.NonInteractive && isInteractive() {
				if err := promptNode(&n); err != nil {
					return err
				}
			}
			if err := n.ValidateEnrollment(); err != nil {
				return err
			}
			return install.NewNode(os.Stdout, os.Stderr).Run(cmd.Context(), n)
		},
	}
	f := cmd.Flags()
	f.StringVar((*string)(&n.Type), "type", string(n.Type), "Node type: nginx, docker, databases, monitoring")
	f.StringVar(&n.Gateway, "gateway", n.Gateway, "Gateway gRPC address")
	f.StringVar(&n.Host, "host", n.Host, "Gateway hostname or IP")
	f.StringVar(&n.Port, "port", n.Port, "Gateway gRPC port")
	f.StringVar(&n.Token, "token", n.Token, "One-time enrollment token")
	f.StringVar(&n.GatewayCertSHA256, "gateway-cert-sha256", n.GatewayCertSHA256, "Gateway TLS leaf fingerprint")
	f.StringVar(&n.Version, "version", n.Version, "Daemon version")
	f.StringVar(&n.RunUser, "user", n.RunUser, "Daemon service user")
	f.StringVar(&n.GitLabURL, "gitlab-url", n.GitLabURL, "GitLab instance URL")
	f.StringVar(&n.GitLabProject, "gitlab-project", n.GitLabProject, "GitLab project path")
	f.BoolVar(&n.SkipNginx, "skip-nginx", n.SkipNginx, "Skip nginx package installation")
	f.StringVar(&n.NginxRepository, "nginx-repo", n.NginxRepository, "Nginx package source")
	f.StringVar(&n.NginxMode, "nginx-mode", n.NginxMode, "Nginx mode: managed or integrate")
	f.StringVar(&n.DatabaseStorageRoot, "storage-root", n.DatabaseStorageRoot, "Database image storage root")
	f.BoolVarP(&n.NonInteractive, "yes", "y", n.NonInteractive, "Do not prompt")
	f.BoolVar(&n.NoLogo, "no-logo", n.NoLogo, "Suppress banner")
	return cmd
}

func isInteractive() bool {
	info, err := os.Stdin.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

func runInteractiveManager(cmd *cobra.Command) error {
	var target string
	form := huh.NewForm(huh.NewGroup(huh.NewSelect[string]().Title("What do you want to install?").Options(huh.NewOption("Gateway control plane", "gateway"), huh.NewOption("Managed node", "node")).Value(&target)))
	if err := form.Run(); err != nil {
		return err
	}
	if target == "gateway" {
		return newGatewayCommand().ExecuteContext(cmd.Context())
	}
	return newNodeCommand().ExecuteContext(cmd.Context())
}

func chooseNodeType(n *config.Node) error {
	var selected string
	form := huh.NewForm(huh.NewGroup(huh.NewSelect[string]().Title("Which node do you want to install?").Options(huh.NewOption("Nginx reverse proxy", string(config.NodeNginx)), huh.NewOption("Docker workloads", string(config.NodeDocker)), huh.NewOption("Managed databases", string(config.NodeDatabases)), huh.NewOption("Host monitoring", string(config.NodeMonitoring))).Value(&selected)))
	if err := form.Run(); err != nil {
		return err
	}
	n.Type = config.NodeType(selected)
	return nil
}

func promptNode(n *config.Node) error {
	fields := []huh.Field{
		huh.NewInput().Title("Gateway gRPC address").Description("Value copied from Gateway is kept as default.").Value(&n.Gateway).Validate(required("Gateway address is required")),
		huh.NewInput().Title("Enrollment token").EchoMode(huh.EchoModePassword).Value(&n.Token).Validate(required("Enrollment token is required")),
		huh.NewInput().Title("Gateway certificate SHA-256 fingerprint").Value(&n.GatewayCertSHA256).Validate(required("Certificate fingerprint is required")),
	}
	if n.Type == config.NodeDatabases && n.DatabaseStorageRoot == "" {
		root, err := install.SelectDatabaseStorageRoot()
		if err != nil {
			return err
		}
		n.DatabaseStorageRoot = root
	}
	if n.Type == config.NodeDatabases {
		fields = append(fields, huh.NewInput().Title("Managed database storage root").Description("Database image files will be created here.").Value(&n.DatabaseStorageRoot).Validate(required("Storage root is required")))
	}
	if err := huh.NewForm(huh.NewGroup(fields...)).Run(); err != nil {
		return err
	}
	return confirm("Install " + string(n.Type) + " node connected to " + n.Gateway + "?")
}

func promptGateway(g *config.Gateway) error {
	if err := huh.NewForm(huh.NewGroup(
		huh.NewInput().Title("Gateway domain (leave empty for direct :3000 access)").Value(&g.Domain),
		huh.NewInput().Title("OIDC issuer URL").Value(&g.OIDCIssuer),
		huh.NewInput().Title("OIDC client ID").Value(&g.OIDCClientID),
		huh.NewInput().Title("OIDC client secret").EchoMode(huh.EchoModePassword).Value(&g.OIDCClientSecret),
	)).Run(); err != nil {
		return err
	}
	label := "direct access on port 3000"
	if g.Domain != "" {
		label = "domain " + g.Domain
	}
	return confirm("Install Gateway with " + label + "?")
}

func confirm(title string) error {
	var accepted bool
	if err := huh.NewForm(huh.NewGroup(huh.NewConfirm().Title(title).Affirmative("Install").Negative("Cancel").Value(&accepted))).Run(); err != nil {
		return err
	}
	if !accepted {
		return fmt.Errorf("installation cancelled")
	}
	return nil
}

func required(message string) func(string) error {
	return func(value string) error {
		if value == "" {
			return fmt.Errorf("%s", message)
		}
		return nil
	}
}
