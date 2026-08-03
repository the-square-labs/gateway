package install

import (
	"context"
	"fmt"
	"os"
	"os/exec"
)

func (i *GatewayInstaller) configureGatewayNginx(ctx context.Context, domain string) error {
	if domain == "" {
		return nil
	}
	if err := NewNode(i.stdout, i.stderr).ensureNginx(ctx, "system"); err != nil {
		return err
	}
	if err := os.MkdirAll("/var/www/acme-challenge/.well-known/acme-challenge", 0755); err != nil {
		return err
	}
	if err := os.MkdirAll("/etc/nginx/conf.d", 0755); err != nil {
		return err
	}
	config := fmt.Sprintf(`server {
    listen 80;
    listen [::]:80;
    server_name %s;

    location /.well-known/acme-challenge/ {
        alias /var/www/acme-challenge/.well-known/acme-challenge/;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
`, domain)
	if err := os.WriteFile("/etc/nginx/conf.d/gateway.conf", []byte(config), 0644); err != nil {
		return err
	}
	if err := i.exec.Run(ctx, "nginx", "-t"); err != nil {
		return fmt.Errorf("validate Gateway nginx config: %w", err)
	}
	if _, err := exec.LookPath("systemctl"); err == nil {
		_ = i.exec.Run(ctx, "systemctl", "enable", "nginx")
		return i.exec.Run(ctx, "systemctl", "restart", "nginx")
	}
	return i.exec.Run(ctx, "nginx", "-s", "reload")
}
