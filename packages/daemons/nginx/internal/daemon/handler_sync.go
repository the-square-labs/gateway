package daemon

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/nginx"
)

func (h *Handler) handleFullSync(cmd *pb.FullSyncCommand, result *pb.CommandResult) {
	h.logger.Info("starting full sync", "hosts", len(cmd.Hosts), "certs", len(cmd.Certs))

	// Snapshot existing configs for rollback
	preExistingConfigs := make(map[string][]byte)
	existingFiles, _ := nginx.ListConfigs(h.cfg.Nginx.ConfigDir)
	for _, name := range existingFiles {
		data, _ := nginx.ReadFile(filepath.Join(h.cfg.Nginx.ConfigDir, name))
		if data != nil {
			preExistingConfigs[name] = data
		}
	}
	preExistingGlobalConfig, err := nginx.ReadFile(h.cfg.Nginx.GlobalConfig)
	if err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("read global config for rollback: %v", err)
		return
	}
	globalConfigTouched := false

	// Track deployed items for rollback
	var deployedCerts []string
	var deployedHtpasswd []string
	deletedStaleConfigs := make(map[string][]byte)
	ownershipRollback := make(map[string]bool)

	rollback := func() {
		// Restore original configs
		for name, data := range preExistingConfigs {
			nginx.WriteAtomic(filepath.Join(h.cfg.Nginx.ConfigDir, name), data)
		}
		// Restore configs that were deleted as stale in Phase 5
		for name, data := range deletedStaleConfigs {
			nginx.WriteAtomic(filepath.Join(h.cfg.Nginx.ConfigDir, name), data)
		}
		if globalConfigTouched {
			if preExistingGlobalConfig != nil {
				_ = nginx.WriteAtomic(h.cfg.Nginx.GlobalConfig, preExistingGlobalConfig)
			} else {
				_ = nginx.RemoveFile(h.cfg.Nginx.GlobalConfig)
			}
		}
		// Remove newly deployed certs
		for _, certId := range deployedCerts {
			nginx.RemoveCert(h.cfg.Nginx.CertsDir, certId)
		}
		// Remove newly deployed htpasswd
		for _, alId := range deployedHtpasswd {
			nginx.RemoveFile(filepath.Join(h.cfg.Nginx.HtpasswdDir, fmt.Sprintf("access-list-%s", alId)))
		}
		for hostID, previous := range ownershipRollback {
			_, _, _ = h.secureLinkState.SetSourceConfigManaged(hostID, previous)
		}
	}

	// Phase 1: Deploy certs
	for _, cert := range cmd.Certs {
		if err := nginx.DeployCert(h.cfg.Nginx.CertsDir, cert.CertId, cert.CertPem, cert.KeyPem, cert.ChainPem); err != nil {
			rollback()
			result.Success = false
			result.Error = fmt.Sprintf("deploy cert %s: %v", cert.CertId, err)
			return
		}
		deployedCerts = append(deployedCerts, cert.CertId)
	}

	// Phase 2: Deploy htpasswd files
	for _, hp := range cmd.HtpasswdFiles {
		path := filepath.Join(h.cfg.Nginx.HtpasswdDir, fmt.Sprintf("access-list-%s", hp.AccessListId))
		if err := nginx.WriteAtomic(path, []byte(hp.Content)); err != nil {
			rollback()
			result.Success = false
			result.Error = fmt.Sprintf("deploy htpasswd %s: %v", hp.AccessListId, err)
			return
		}
		deployedHtpasswd = append(deployedHtpasswd, hp.AccessListId)
	}

	// Phase 3: Write all host configs
	activeHosts := make(map[string]bool)
	for _, host := range cmd.Hosts {
		if host.ConfigOwnership != "" && h.secureLinkState != nil {
			managed := host.ConfigOwnership == configOwnershipManagedSecureLink
			if !managed && host.ConfigOwnership != configOwnershipUserOwned {
				rollback()
				result.Success = false
				result.Error = fmt.Sprintf("invalid config ownership %s", host.HostId)
				return
			}
			previous, found, err := h.secureLinkState.SetSourceConfigManaged(host.HostId, managed)
			if err != nil {
				rollback()
				result.Success = false
				result.Error = fmt.Sprintf("persist config ownership %s: %v", host.HostId, err)
				return
			}
			if found {
				ownershipRollback[host.HostId] = previous
			}
		}
		path := h.mgr.ConfigPath(host.HostId)
		if err := nginx.WriteAtomic(path, []byte(host.ConfigContent)); err != nil {
			rollback()
			result.Success = false
			result.Error = fmt.Sprintf("write config %s: %v", host.HostId, err)
			return
		}
		activeHosts[fmt.Sprintf("proxy-host-%s.conf", host.HostId)] = true
	}

	// Phase 4: Update global config if provided
	if cmd.GlobalConfig != "" {
		if err := nginx.WriteAtomic(h.cfg.Nginx.GlobalConfig, []byte(cmd.GlobalConfig)); err != nil {
			rollback()
			result.Success = false
			result.Error = fmt.Sprintf("write global config: %v", err)
			return
		}
		globalConfigTouched = true
	}

	// Phase 5: Remove stale configs (save content for potential rollback)
	existing, _ := nginx.ListConfigs(h.cfg.Nginx.ConfigDir)
	for _, name := range existing {
		if !activeHosts[name] && strings.HasPrefix(name, "proxy-host-") {
			if data, ok := preExistingConfigs[name]; ok {
				deletedStaleConfigs[name] = data
			}
			os.Remove(filepath.Join(h.cfg.Nginx.ConfigDir, name))
		}
	}

	// Phase 6: Test and reload
	valid, output := h.mgr.TestConfig()
	result.Detail = output
	if !valid {
		rollback()
		_, _ = h.mgr.TestConfig()
		result.Success = false
		result.Error = fmt.Sprintf("nginx config test failed: %s", output)
		return
	}

	if err := h.mgr.Reload(); err != nil {
		rollback()
		_, _ = h.mgr.TestConfig()
		result.Success = false
		result.Error = fmt.Sprintf("nginx reload failed: %v", err)
		return
	}
	// Update state
	hostIDs := make([]string, 0, len(cmd.Hosts))
	for _, host := range cmd.Hosts {
		hostIDs = append(hostIDs, host.HostId)
	}
	h.state.SetExtra("active_host_ids", hostIDs)
	h.state.SetExtra("config_version_hash", cmd.VersionHash)
	h.state.Save()

	h.logger.Info("full sync complete", "version_hash", cmd.VersionHash)
}

func (h *Handler) handleUpdateGlobalConfig(cmd *pb.UpdateGlobalConfigCommand, result *pb.CommandResult) {
	// Backup current config
	backup, err := nginx.ReadFile(h.cfg.Nginx.GlobalConfig)
	if err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("read global config for rollback: %v", err)
		return
	}
	rollback := func() error {
		if backup != nil {
			return nginx.WriteAtomic(h.cfg.Nginx.GlobalConfig, backup)
		}
		return nginx.RemoveFile(h.cfg.Nginx.GlobalConfig)
	}

	if err := nginx.WriteAtomic(h.cfg.Nginx.GlobalConfig, []byte(cmd.Content)); err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("write global config: %v", err)
		return
	}

	valid, output := h.mgr.TestConfig()
	result.Detail = output
	if !valid {
		rollbackErr := rollback()
		_, _ = h.mgr.TestConfig()
		result.Success = false
		result.Error = fmt.Sprintf("nginx config test failed: %s", output)
		if rollbackErr != nil {
			result.Error += fmt.Sprintf("; rollback global config: %v", rollbackErr)
		}
		return
	}

	if err := h.mgr.Reload(); err != nil {
		rollbackErr := rollback()
		_, _ = h.mgr.TestConfig()
		result.Success = false
		result.Error = fmt.Sprintf("nginx reload failed: %v", err)
		if rollbackErr != nil {
			result.Error += fmt.Sprintf("; rollback global config: %v", rollbackErr)
		}
		return
	}

	h.logger.Info("global config updated")
}

func (h *Handler) handleDeployHtpasswd(cmd *pb.DeployHtpasswdCommand, result *pb.CommandResult) {
	path := filepath.Join(h.cfg.Nginx.HtpasswdDir, fmt.Sprintf("access-list-%s", cmd.AccessListId))
	if err := nginx.WriteAtomic(path, []byte(cmd.Content)); err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("deploy htpasswd: %v", err)
		return
	}
	h.logger.Info("htpasswd deployed", "access_list_id", cmd.AccessListId)
}

func (h *Handler) handleRemoveHtpasswd(cmd *pb.RemoveHtpasswdCommand, result *pb.CommandResult) {
	path := filepath.Join(h.cfg.Nginx.HtpasswdDir, fmt.Sprintf("access-list-%s", cmd.AccessListId))
	if err := nginx.RemoveFile(path); err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("remove htpasswd: %v", err)
		return
	}
	h.logger.Info("htpasswd removed", "access_list_id", cmd.AccessListId)
}

func (h *Handler) handleTestConfig(result *pb.CommandResult) {
	valid, output := h.mgr.TestConfig()
	result.Detail = output
	if !valid {
		result.Success = false
		result.Error = output
	}
}

func (h *Handler) handleDeployAcmeChallenge(cmd *pb.DeployAcmeChallengeCommand, result *pb.CommandResult) {
	if !acmeTokenRegex.MatchString(cmd.Token) {
		result.Success = false
		result.Error = "invalid ACME token format"
		return
	}
	dir := filepath.Join(h.cfg.Nginx.AcmeChallengeDir, ".well-known", "acme-challenge")
	path := filepath.Join(dir, cmd.Token)
	if err := nginx.WriteAtomic(path, []byte(cmd.Content)); err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("deploy ACME challenge: %v", err)
		return
	}
	h.logger.Info("ACME challenge deployed", "token", cmd.Token)
}

func (h *Handler) handleRemoveAcmeChallenge(cmd *pb.RemoveAcmeChallengeCommand, result *pb.CommandResult) {
	if !acmeTokenRegex.MatchString(cmd.Token) {
		result.Success = false
		result.Error = "invalid ACME token format"
		return
	}
	path := filepath.Join(h.cfg.Nginx.AcmeChallengeDir, ".well-known", "acme-challenge", cmd.Token)
	if err := nginx.RemoveFile(path); err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("remove ACME challenge: %v", err)
		return
	}
	h.logger.Info("ACME challenge removed", "token", cmd.Token)
}

func (h *Handler) handleReadGlobalConfig(result *pb.CommandResult) {
	data, err := nginx.ReadFile(h.cfg.Nginx.GlobalConfig)
	if err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("read global config: %v", err)
		return
	}
	if data == nil {
		result.Success = false
		result.Error = "global config file not found"
		return
	}
	result.Detail = string(data)
}
