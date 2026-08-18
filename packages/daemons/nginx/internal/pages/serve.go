package pages

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func (r *Runtime) applyConfig(configPath string, next []byte) error {
	old, err := os.ReadFile(configPath)
	oldExists := err == nil
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if (next == nil && !oldExists) || (next != nil && oldExists && string(old) == string(next)) {
		return nil
	}
	if next == nil {
		if err := os.Remove(configPath); err != nil && !os.IsNotExist(err) {
			return err
		}
	} else if err := writeAtomic(configPath, next, 0o640); err != nil {
		return err
	}
	restore := func() error {
		if oldExists {
			return writeAtomic(configPath, old, 0o640)
		}
		if err := os.Remove(configPath); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	valid, output := r.nginx.TestConfig()
	if !valid {
		_ = restore()
		return fmt.Errorf("nginx config test failed: %s", output)
	}
	if err := r.nginx.Reload(); err != nil {
		if restoreErr := restore(); restoreErr != nil {
			return fmt.Errorf("nginx reload failed: %v; restore failed: %w", err, restoreErr)
		}
		if restoreErr := r.nginx.Reload(); restoreErr != nil {
			return fmt.Errorf("nginx reload failed: %v; restore reload failed: %w", err, restoreErr)
		}
		return fmt.Errorf("nginx reload failed: %w", err)
	}
	return nil
}

func (r *Runtime) isReferenced(deploymentID string) bool {
	needle := r.releaseContentDir(deploymentID)
	paths, _ := filepath.Glob(filepath.Join(r.configDir, "pages-preview-*.conf"))
	routes, _ := filepath.Glob(filepath.Join(r.configDir, "pages", "routes", "*.inc"))
	paths = append(paths, routes...)
	for _, configPath := range paths {
		if content, err := os.ReadFile(configPath); err == nil && strings.Contains(string(content), needle) {
			return true
		}
	}
	return false
}

func (r *Runtime) previewConfig(hostname, deploymentID, certificateID, certificateVersion, runtimeConfigPath string) string {
	lines := []string{"# gateway-pages immutable preview", "server {", "    listen 80;"}
	if certificateID != "" {
		certRoot := filepath.Join(r.certsDir, certificateID, "versions", certificateVersion)
		lines = append(lines, "    listen 443 ssl;", "    ssl_certificate "+filepath.Join(certRoot, "fullchain.pem")+";", "    ssl_certificate_key "+filepath.Join(certRoot, "privkey.pem")+";")
	}
	lines = append(lines, "    server_name "+hostname+";", "    root "+r.releaseContentDir(deploymentID)+";", "    index index.html;", "    add_header X-Content-Type-Options nosniff always;", "    add_header Referrer-Policy same-origin always;", "    location = /_gateway/pages/config.js {", "        limit_except GET HEAD { deny all; }", "        alias "+runtimeConfigPath+";", "        default_type application/javascript;", "        add_header Cache-Control \"no-store, max-age=0\" always;", "    }", "    location ~ /\\. { deny all; }", "    location / {", "        limit_except GET HEAD { deny all; }", "        sub_filter_once on;", "        sub_filter '</head>' '<script src=\"/_gateway/pages/config.js\"></script></head>';", "        try_files $uri $uri/ =404;", "    }", "    location ~* \\.(?:css|js|mjs|json|png|jpe?g|gif|svg|ico|webp|avif|woff2?)$ {", "        limit_except GET HEAD { deny all; }", "        expires 1y;", "        add_header Cache-Control \"public, max-age=31536000, immutable\" always;", "    }", "}")
	return strings.Join(lines, "\n") + "\n"
}
