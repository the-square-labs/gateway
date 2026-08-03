package install

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/wiolett-industries/gateway/installer/internal/config"
)

type enrollmentResponse struct {
	EnrollmentToken   string `json:"enrollmentToken"`
	GatewayCertSHA256 string `json:"gatewayCertSha256"`
}

func (i *GatewayInstaller) bootstrap(ctx context.Context, gateway config.Gateway) error {
	token, err := envFileValue(".env", "SETUP_TOKEN")
	if err != nil || token == "" {
		if err != nil {
			return fmt.Errorf("setup token unavailable: %w", err)
		}
		return fmt.Errorf("setup token unavailable")
	}
	if err := waitGatewayHealth(ctx); err != nil {
		return fmt.Errorf("Gateway health check: %w", err)
	}
	if err := bootstrapAuth(ctx, gateway, token); err != nil {
		return fmt.Errorf("authentication bootstrap: %w", err)
	}
	if gateway.Domain != "" {
		if err := i.configureGatewayNginx(ctx, gateway.Domain); err != nil {
			fmt.Fprintln(i.stderr, "Warning: configure nginx: "+err.Error())
		}
		if err := i.autoEnrollNginx(ctx, token); err != nil {
			fmt.Fprintln(i.stderr, "Warning: auto-enroll nginx node: "+err.Error())
		}
		if err := bootstrapSSL(ctx, gateway, token); err != nil {
			fmt.Fprintln(i.stderr, "Warning: management SSL: "+err.Error())
		}
	}
	if err := setupPost(ctx, "/api/setup/complete", token, nil, 15*time.Second); err != nil {
		return fmt.Errorf("setup API lock: %w", err)
	}
	return nil
}

func bootstrapAuth(ctx context.Context, gateway config.Gateway, token string) error {
	methods := parseAuthMethods(gateway.AuthMethods)
	payload := map[string]any{
		"methods":      map[string]bool{"oidc": methods["oidc"], "password": methods["password"], "emailOtp": methods["emailOtp"]},
		"initialAdmin": map[string]string{"email": gateway.InitialAdminEmail, "name": gateway.InitialAdminName, "authMethod": gateway.InitialAdminMethod},
	}
	if gateway.InitialAdminPassword != "" {
		payload["initialAdmin"].(map[string]string)["password"] = gateway.InitialAdminPassword
	}
	if methods["oidc"] {
		payload["oidc"] = map[string]string{"issuer": gateway.OIDCIssuer, "clientId": gateway.OIDCClientID, "clientSecret": gateway.OIDCClientSecret, "redirectUri": gateway.OIDCRedirectURI, "scopes": "openid email profile"}
	}
	if methods["password"] || methods["emailOtp"] {
		port := 0
		if _, err := fmt.Sscan(gateway.SMTPPort, &port); err != nil || port < 1 {
			return fmt.Errorf("invalid SMTP port")
		}
		payload["smtp"] = map[string]any{"host": gateway.SMTPHost, "port": port, "tlsMode": gateway.SMTPTLSMode, "username": gateway.SMTPUsername, "password": gateway.SMTPPassword, "senderName": gateway.SMTPSenderName, "senderEmail": gateway.SMTPSenderEmail, "testRecipient": gateway.InitialAdminEmail}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = setupPostJSON(ctx, "/api/setup/auth-bootstrap", token, body, 45*time.Second)
	return err
}

func waitGatewayHealth(ctx context.Context) error {
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		if err := setupGet(ctx, "/health", 3*time.Second); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return fmt.Errorf("timeout waiting for Gateway health")
}

func (i *GatewayInstaller) autoEnrollNginx(ctx context.Context, token string) error {
	host, err := os.Hostname()
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]string{"type": "nginx", "hostname": host})
	body, err := setupPostJSON(ctx, "/api/setup/enroll-node", token, payload, 20*time.Second)
	if err != nil {
		return err
	}
	var enrollment enrollmentResponse
	if err := json.Unmarshal(body, &enrollment); err != nil {
		return err
	}
	if enrollment.EnrollmentToken == "" || enrollment.GatewayCertSHA256 == "" {
		return fmt.Errorf("setup API did not return enrollment credentials")
	}
	return NewNode(i.stdout, i.stderr).Run(ctx, config.Node{Type: config.NodeNginx, Gateway: "127.0.0.1:9443", Token: enrollment.EnrollmentToken, GatewayCertSHA256: enrollment.GatewayCertSHA256, Version: "latest", RunUser: "root", NonInteractive: true})
}

func bootstrapSSL(ctx context.Context, gateway config.Gateway, token string) error {
	if gateway.Domain == "localhost" || !strings.Contains(gateway.Domain, ".") {
		return nil
	}
	endpoint := "/api/setup/management-ssl"
	request := map[string]string{"domain": gateway.Domain}
	if gateway.SSLCert != "" || gateway.SSLKey != "" {
		if gateway.SSLCert == "" || gateway.SSLKey == "" {
			return fmt.Errorf("both --ssl-cert and --ssl-key are required")
		}
		certificate, err := os.ReadFile(gateway.SSLCert)
		if err != nil {
			return err
		}
		privateKey, err := os.ReadFile(gateway.SSLKey)
		if err != nil {
			return err
		}
		request["certificatePem"], request["privateKeyPem"] = string(certificate), string(privateKey)
		if gateway.SSLChain != "" {
			chain, err := os.ReadFile(gateway.SSLChain)
			if err != nil {
				return err
			}
			request["chainPem"] = string(chain)
		}
		endpoint = "/api/setup/management-ssl-upload"
	}
	payload, _ := json.Marshal(request)
	_, err := setupPostJSON(ctx, endpoint, token, payload, 120*time.Second)
	return err
}

func setupGet(ctx context.Context, path string, timeout time.Duration) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:3000"+path, nil)
	if err != nil {
		return err
	}
	response, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return fmt.Errorf("%s", response.Status)
	}
	return nil
}

func setupPost(ctx context.Context, path, token string, payload []byte, timeout time.Duration) error {
	_, err := setupPostJSON(ctx, path, token, payload, timeout)
	return err
}
func setupPostJSON(ctx context.Context, path, token string, payload []byte, timeout time.Duration) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://127.0.0.1:3000"+path, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	response, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, fmt.Errorf("%s returned %s", path, response.Status)
	}
	return body, nil
}

func envFileValue(path, key string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, key+"=") {
			return strings.TrimPrefix(line, key+"="), nil
		}
	}
	return "", nil
}
