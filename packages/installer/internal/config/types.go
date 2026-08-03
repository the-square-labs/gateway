package config

import "fmt"

type NodeType string

const (
	NodeNginx      NodeType = "nginx"
	NodeDocker     NodeType = "docker"
	NodeDatabases  NodeType = "databases"
	NodeMonitoring NodeType = "monitoring"
)

func (t NodeType) Valid() bool {
	switch t {
	case NodeNginx, NodeDocker, NodeDatabases, NodeMonitoring:
		return true
	default:
		return false
	}
}

type Node struct {
	Type                NodeType
	Gateway             string
	Host                string
	Port                string
	Token               string
	GatewayCertSHA256   string
	Version             string
	RunUser             string
	GitLabURL           string
	GitLabProject       string
	SkipNginx           bool
	NginxRepository     string
	NginxMode           string
	DatabaseStorageRoot string
	NonInteractive      bool
	NoLogo              bool
}

func (n *Node) Normalize() error {
	if n.Gateway == "" && n.Host != "" {
		if n.Port == "" {
			n.Port = "9443"
		}
		n.Gateway = n.Host + ":" + n.Port
	}
	if n.Gateway != "" && n.Host == "" {
		n.Host = n.Gateway
	}
	if n.Port == "" {
		n.Port = "9443"
	}
	if n.Version == "" {
		n.Version = "latest"
	}
	if n.RunUser == "" {
		n.RunUser = "root"
	}
	if n.GitLabURL == "" {
		n.GitLabURL = "https://gitlab.wiolett.net"
	}
	if n.GitLabProject == "" {
		n.GitLabProject = "wiolett/gateway"
	}
	return nil
}

func (n Node) ValidateEnrollment() error {
	if !n.Type.Valid() {
		return fmt.Errorf("--type must be nginx, docker, databases, or monitoring")
	}
	if n.Gateway == "" {
		return fmt.Errorf("--gateway or --host is required")
	}
	if n.Token == "" {
		return fmt.Errorf("--token is required")
	}
	if n.GatewayCertSHA256 == "" {
		return fmt.Errorf("--gateway-cert-sha256 is required")
	}
	if n.Type == NodeDatabases && n.DatabaseStorageRoot == "" {
		return fmt.Errorf("--storage-root is required for a database node in non-interactive mode")
	}
	return nil
}

type Gateway struct {
	Version              string
	Image                string
	GitLabURL            string
	GitLabProject        string
	Domain               string
	ACMEEmail            string
	OIDCIssuer           string
	OIDCClientID         string
	OIDCClientSecret     string
	OIDCRedirectURI      string
	AuthMethods          string
	SMTPHost             string
	SMTPPort             string
	SMTPTLSMode          string
	SMTPUsername         string
	SMTPPassword         string
	SMTPSenderName       string
	SMTPSenderEmail      string
	InitialAdminEmail    string
	InitialAdminName     string
	InitialAdminMethod   string
	InitialAdminPassword string
	ACMEStaging          bool
	SSLCert              string
	SSLKey               string
	SSLChain             string
	ResourceProfile      string
	DatabaseMode         string
	DatabaseURL          string
	LoggingMode          string
	ClickHouseURL        string
	ClickHouseUsername   string
	ClickHousePassword   string
	ClickHouseDatabase   string
	ClickHouseTable      string
	LogMaxSize           string
	LogMaxFile           string
	LogRotation          bool
	RestrictEnv          bool
	NginxVersion         string
	SkipStart            bool
	NonInteractive       bool
	NoLogo               bool
}

func (g *Gateway) Normalize() {
	if g.Version == "" {
		g.Version = "latest"
	}
	if g.Image == "" {
		g.Image = "registry.gitlab.wiolett.net/wiolett/gateway"
	}
	if g.GitLabURL == "" {
		g.GitLabURL = "https://gitlab.wiolett.net"
	}
	if g.GitLabProject == "" {
		g.GitLabProject = "wiolett/gateway"
	}
	if g.OIDCClientID == "" {
		g.OIDCClientID = "gateway"
	}
	if g.ResourceProfile == "" {
		g.ResourceProfile = "medium"
	}
	if g.DatabaseMode == "" {
		g.DatabaseMode = "local"
	}
	if g.LoggingMode == "" {
		g.LoggingMode = "local"
	}
	if g.ClickHouseUsername == "" {
		g.ClickHouseUsername = "gateway"
	}
	if g.ClickHouseDatabase == "" {
		g.ClickHouseDatabase = "gateway_logs"
	}
	if g.ClickHouseTable == "" {
		g.ClickHouseTable = "logs"
	}
	if g.LogMaxSize == "" {
		g.LogMaxSize = "50m"
	}
	if g.LogMaxFile == "" {
		g.LogMaxFile = "3"
	}
	if g.NginxVersion == "" {
		g.NginxVersion = "system"
	}
}
