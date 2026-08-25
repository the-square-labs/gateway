package daemon

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
	sharedstate "github.com/wiolett-industries/gateway/daemon-shared/state"
	"github.com/wiolett-industries/gateway/daemon-shared/stream"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/config"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/nginx"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/pages"
)

// acmeTokenRegex validates ACME challenge tokens (alphanumeric + dash + underscore).
var acmeTokenRegex = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// uuidRegex validates UUID-format strings.
var uuidRegex = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

var certificateIDRegex = regexp.MustCompile(`^(?:internal-)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var certificateVersionRegex = regexp.MustCompile(`^[0-9a-f]{64}$`)
var replicaGenerationRegex = regexp.MustCompile(`^[1-9][0-9]*$`)

// isValidUUID checks if a string is a valid UUID format.
func isValidUUID(s string) bool {
	return uuidRegex.MatchString(s)
}

func isValidCertificateID(s string) bool {
	return certificateIDRegex.MatchString(s)
}

type Handler struct {
	cfg                         *config.Config
	mgr                         *nginx.Manager
	state                       *sharedstate.State
	logger                      *slog.Logger
	secureLinkState             *securelink.StateStore
	pagesRuntime                *pages.Runtime
	pagesRuntimeConfigAvailable bool
}

func NewHandler(cfg *config.Config, mgr *nginx.Manager, st *sharedstate.State, logger *slog.Logger, secureLinkState *securelink.StateStore, pagesRuntime *pages.Runtime, pagesRuntimeConfigAvailable bool) *Handler {
	return &Handler{cfg: cfg, mgr: mgr, state: st, logger: logger, secureLinkState: secureLinkState, pagesRuntime: pagesRuntime, pagesRuntimeConfigAvailable: pagesRuntimeConfigAvailable}
}

const (
	configOwnershipManagedSecureLink = "managed_secure_link"
	configOwnershipUserOwned         = "user_owned"
)

func (h *Handler) setConfigOwnership(hostID, ownership string) (func(), error) {
	if ownership == "" || h.secureLinkState == nil {
		return func() {}, nil
	}
	if ownership != configOwnershipManagedSecureLink && ownership != configOwnershipUserOwned {
		return nil, errors.New("invalid config ownership")
	}
	managed := ownership == configOwnershipManagedSecureLink
	previous, found, err := h.secureLinkState.SetSourceConfigManaged(hostID, managed)
	if err != nil || !found {
		return func() {}, err
	}
	return func() {
		_, _, _ = h.secureLinkState.SetSourceConfigManaged(hostID, previous)
	}, nil
}

// HandleCommand processes a GatewayCommand and returns a CommandResult.
func (h *Handler) HandleCommand(cmd *pb.GatewayCommand) *pb.CommandResult {
	result := &pb.CommandResult{CommandId: cmd.CommandId, Success: true}

	switch payload := cmd.Payload.(type) {
	case *pb.GatewayCommand_ApplyConfig:
		h.handleApplyConfig(payload.ApplyConfig, result)
	case *pb.GatewayCommand_RemoveConfig:
		h.handleRemoveConfig(payload.RemoveConfig, result)
	case *pb.GatewayCommand_DeployCert:
		h.handleDeployCert(payload.DeployCert, result)
	case *pb.GatewayCommand_RemoveCert:
		h.handleRemoveCert(payload.RemoveCert, result)
	case *pb.GatewayCommand_ApplyTlsBundle:
		h.handleApplyTlsBundle(payload.ApplyTlsBundle, result)
	case *pb.GatewayCommand_InspectCertificates:
		h.handleInspectCertificates(payload.InspectCertificates, result)
	case *pb.GatewayCommand_ExportLegacyCertificates:
		h.handleExportLegacyCertificates(payload.ExportLegacyCertificates, result)
	case *pb.GatewayCommand_RemoveCertificateReplica:
		h.handleRemoveCertificateReplica(payload.RemoveCertificateReplica, result)
	case *pb.GatewayCommand_FullSync:
		h.handleFullSync(payload.FullSync, result)
	case *pb.GatewayCommand_UpdateGlobalConfig:
		h.handleUpdateGlobalConfig(payload.UpdateGlobalConfig, result)
	case *pb.GatewayCommand_DeployHtpasswd:
		h.handleDeployHtpasswd(payload.DeployHtpasswd, result)
	case *pb.GatewayCommand_RemoveHtpasswd:
		h.handleRemoveHtpasswd(payload.RemoveHtpasswd, result)
	case *pb.GatewayCommand_TestConfig:
		h.handleTestConfig(result)
	case *pb.GatewayCommand_DeployAcmeChallenge:
		h.handleDeployAcmeChallenge(payload.DeployAcmeChallenge, result)
	case *pb.GatewayCommand_RemoveAcmeChallenge:
		h.handleRemoveAcmeChallenge(payload.RemoveAcmeChallenge, result)
	case *pb.GatewayCommand_SetDaemonLogStream:
		h.handleSetDaemonLogStream(payload.SetDaemonLogStream, result)
	case *pb.GatewayCommand_ReadGlobalConfig:
		h.handleReadGlobalConfig(result)
	case *pb.GatewayCommand_RequestTrafficStats:
		h.handleRequestTrafficStats(payload.RequestTrafficStats, result)
	case *pb.GatewayCommand_PagesUploadInit:
		h.handlePagesUploadInit(payload.PagesUploadInit, result)
	case *pb.GatewayCommand_PagesUploadChunk:
		h.handlePagesUploadChunk(payload.PagesUploadChunk, result)
	case *pb.GatewayCommand_PagesUploadFinalize:
		h.handlePagesUploadFinalize(payload.PagesUploadFinalize, result)
	case *pb.GatewayCommand_PagesVerifyRelease:
		h.handlePagesVerifyRelease(payload.PagesVerifyRelease, result)
	case *pb.GatewayCommand_PagesMaterializePreview:
		h.handlePagesMaterializePreview(payload.PagesMaterializePreview, result)
	case *pb.GatewayCommand_PagesRemovePreview:
		h.handlePagesRemovePreview(payload.PagesRemovePreview, result)
	case *pb.GatewayCommand_PagesActivateTagRoute:
		h.handlePagesActivateTagRoute(payload.PagesActivateTagRoute, result)
	case *pb.GatewayCommand_PagesDeactivateTagRoute:
		h.handlePagesDeactivateTagRoute(payload.PagesDeactivateTagRoute, result)
	case *pb.GatewayCommand_PagesCleanupDeployment:
		h.handlePagesCleanupDeployment(payload.PagesCleanupDeployment, result)
	case *pb.GatewayCommand_PagesInventory:
		h.handlePagesInventory(result)
	case *pb.GatewayCommand_PagesStoragePreflight:
		h.handlePagesStoragePreflight(payload.PagesStoragePreflight, result)
	case *pb.GatewayCommand_PagesDeployCertificate:
		h.handlePagesDeployCertificate(payload.PagesDeployCertificate, result)
	case *pb.GatewayCommand_PagesStageRuntimeConfig:
		h.handlePagesStageRuntimeConfig(payload.PagesStageRuntimeConfig, result)
	case *pb.GatewayCommand_PagesActivateRuntimeConfig:
		h.handlePagesActivateRuntimeConfig(payload.PagesActivateRuntimeConfig, result)
	case *pb.GatewayCommand_PagesRemoveRuntimeConfig:
		h.handlePagesRemoveRuntimeConfig(payload.PagesRemoveRuntimeConfig, result)
	default:
		result.Success = false
		result.Error = "unknown command type"
	}

	return result
}

func (h *Handler) handleApplyConfig(cmd *pb.ApplyConfigCommand, result *pb.CommandResult) {
	path := h.mgr.ConfigPath(cmd.HostId)

	// Read old config for rollback
	oldConfig, _ := nginx.ReadFile(path)
	rollbackConfig := func() error {
		if oldConfig != nil {
			return nginx.WriteAtomic(path, oldConfig)
		}
		return nginx.RemoveFile(path)
	}
	restoreOwnership, err := h.setConfigOwnership(cmd.HostId, cmd.ConfigOwnership)
	if err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("persist config ownership: %v", err)
		return
	}

	if err := nginx.WriteAtomic(path, []byte(cmd.ConfigContent)); err != nil {
		restoreOwnership()
		result.Success = false
		result.Error = fmt.Sprintf("write config: %v", err)
		return
	}

	valid, output := h.mgr.TestConfig()
	result.Detail = output

	if !valid {
		_ = rollbackConfig()
		restoreOwnership()
		result.Success = false
		result.Error = fmt.Sprintf("nginx config test failed: %s", output)
		return
	}

	if cmd.TestOnly {
		// Test passed, don't reload. Restore old config.
		_ = rollbackConfig()
		restoreOwnership()
		return
	}

	if err := h.mgr.Reload(); err != nil {
		rollbackErr := rollbackConfig()
		restoreOwnership()
		result.Success = false
		if rollbackErr != nil {
			result.Error = fmt.Sprintf("nginx reload failed: %v; rollback config: %v", err, rollbackErr)
		} else {
			result.Error = fmt.Sprintf("nginx reload failed: %v", err)
		}
		return
	}
	h.logger.Info("config applied", "host_id", cmd.HostId)
}

func (h *Handler) handleRemoveConfig(cmd *pb.RemoveConfigCommand, result *pb.CommandResult) {
	path := h.mgr.ConfigPath(cmd.HostId)
	oldConfig, _ := nginx.ReadFile(path)
	if err := nginx.RemoveFile(path); err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("remove config: %v", err)
		return
	}

	// Clean up cache directory
	cacheDir := fmt.Sprintf("/tmp/nginx-cache-%s", cmd.HostId)
	nginx.RemoveDir(cacheDir)

	valid, output := h.mgr.TestConfig()
	result.Detail = output
	if !valid {
		if oldConfig != nil {
			_ = nginx.WriteAtomic(path, oldConfig)
		}
		result.Success = false
		result.Error = fmt.Sprintf("nginx config test failed after removal: %s", output)
		return
	}

	if err := h.mgr.Reload(); err != nil {
		if oldConfig != nil {
			_ = nginx.WriteAtomic(path, oldConfig)
		}
		result.Success = false
		result.Error = fmt.Sprintf("nginx reload failed: %v", err)
		return
	}

	h.logger.Info("config removed", "host_id", cmd.HostId)
}

func (h *Handler) handleDeployCert(cmd *pb.DeployCertCommand, result *pb.CommandResult) {
	if !isValidCertificateID(cmd.CertId) {
		result.Success = false
		result.Error = "invalid certificate id"
		return
	}
	if err := nginx.DeployCert(h.cfg.Nginx.CertsDir, cmd.CertId, cmd.CertPem, cmd.KeyPem, cmd.ChainPem); err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("deploy cert: %v", err)
		return
	}
	h.logger.Info("cert deployed", "cert_id", cmd.CertId)
}

func (h *Handler) handleRemoveCert(cmd *pb.RemoveCertCommand, result *pb.CommandResult) {
	if !isValidCertificateID(cmd.CertId) {
		result.Success = false
		result.Error = "invalid certificate id"
		return
	}
	if err := nginx.RemoveCert(h.cfg.Nginx.CertsDir, cmd.CertId); err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("remove cert: %v", err)
		return
	}
	h.logger.Info("cert removed", "cert_id", cmd.CertId)
}

type certificateInventoryResult struct {
	Certificates []certificateInventoryItem `json:"certificates"`
}

type certificateInventoryItem struct {
	CertID      string `json:"certId"`
	Present     bool   `json:"present"`
	Version     string `json:"version"`
	Fingerprint string `json:"fingerprint"`
}

type legacyCertificateExportResult struct {
	Certificates []legacyCertificateExport `json:"certificates"`
}

type legacyCertificateExport struct {
	CertID   string `json:"certId"`
	CertPem  []byte `json:"certPem"`
	KeyPem   []byte `json:"keyPem"`
	ChainPem []byte `json:"chainPem,omitempty"`
}

// handleApplyTlsBundle preserves the currently loaded TLS configuration until
// both the certificate pointer and config have passed nginx -t and reload.
func (h *Handler) handleApplyTlsBundle(cmd *pb.ApplyTlsBundleCommand, result *pb.CommandResult) {
	if !isValidUUID(cmd.HostId) || !certificateVersionRegex.MatchString(cmd.Generation) {
		result.Success = false
		result.Error = "invalid TLS bundle identifier"
		return
	}
	configPath := h.mgr.ConfigPath(cmd.HostId)
	oldConfig, _ := nginx.ReadFile(configPath)
	pointers := make(map[string]nginx.CertPointer, len(cmd.Certificates))
	restoreOwnership := func() {}

	rollback := func() {
		if oldConfig != nil {
			_ = nginx.WriteAtomic(configPath, oldConfig)
		} else {
			_ = nginx.RemoveFile(configPath)
		}
		for certID, pointer := range pointers {
			_ = nginx.RestoreCertPointer(h.cfg.Nginx.CertsDir, certID, pointer)
		}
		// A failed test/reload must leave the loaded server on the last known
		// valid pair as well as restoring files on disk. Best effort is correct
		// here: the original failure remains the command result.
		if valid, _ := h.mgr.TestConfig(); valid {
			_ = h.mgr.Reload()
		}
		restoreOwnership()
	}

	for _, cert := range cmd.Certificates {
		if !isValidCertificateID(cert.CertId) || !certificateVersionRegex.MatchString(cert.Version) || !replicaGenerationRegex.MatchString(cert.ReplicaGeneration) {
			result.Success = false
			result.Error = "invalid TLS certificate identifier"
			return
		}
		pointer, err := nginx.DeployVersionedCert(
			h.cfg.Nginx.CertsDir,
			cert.CertId,
			cert.Version,
			cert.ReplicaGeneration,
			cert.CertPem,
			cert.KeyPem,
			cert.ChainPem,
		)
		if err != nil {
			rollback()
			result.Success = false
			result.Error = "stage TLS certificate failed"
			return
		}
		pointers[cert.CertId] = pointer
	}
	restoreOwnership, err := h.setConfigOwnership(cmd.HostId, cmd.ConfigOwnership)
	if err != nil {
		rollback()
		result.Success = false
		result.Error = "persist TLS config ownership failed"
		return
	}

	if err := nginx.WriteAtomic(configPath, []byte(cmd.ConfigContent)); err != nil {
		rollback()
		result.Success = false
		result.Error = "write TLS proxy configuration failed"
		return
	}
	valid, output := h.mgr.TestConfig()
	result.Detail = output
	if !valid {
		rollback()
		result.Success = false
		result.Error = "nginx config test failed"
		return
	}
	if err := h.mgr.Reload(); err != nil {
		rollback()
		result.Success = false
		result.Error = "nginx reload failed"
		return
	}
	h.state.SetExtra("last_tls_bundle_generation", cmd.Generation)
	h.state.Save()
	h.logger.Info("TLS bundle applied", "host_id", cmd.HostId, "certificate_count", len(cmd.Certificates))
}

func (h *Handler) handleInspectCertificates(cmd *pb.InspectCertificatesCommand, result *pb.CommandResult) {
	response := certificateInventoryResult{Certificates: make([]certificateInventoryItem, 0, len(cmd.CertIds))}
	for _, certID := range cmd.CertIds {
		if !isValidCertificateID(certID) {
			result.Success = false
			result.Error = "invalid certificate id"
			return
		}
		snapshot, err := nginx.InspectCertificate(h.cfg.Nginx.CertsDir, certID)
		if err != nil {
			result.Success = false
			result.Error = "certificate inspection failed"
			return
		}
		response.Certificates = append(response.Certificates, certificateInventoryItem{
			CertID: certID, Present: snapshot.Present, Version: snapshot.Version, Fingerprint: snapshot.Fingerprint,
		})
	}
	data, err := json.Marshal(response)
	if err != nil {
		result.Success = false
		result.Error = "certificate inspection serialization failed"
		return
	}
	result.Data = data
}

func (h *Handler) handleExportLegacyCertificates(cmd *pb.ExportLegacyCertificatesCommand, result *pb.CommandResult) {
	response := legacyCertificateExportResult{Certificates: make([]legacyCertificateExport, 0, len(cmd.CertIds))}
	for _, certID := range cmd.CertIds {
		if !isValidCertificateID(certID) {
			result.Success = false
			result.Error = "invalid certificate id"
			return
		}
		certPem, keyPem, chainPem, err := nginx.ReadCertificateForExport(h.cfg.Nginx.CertsDir, certID)
		if err != nil {
			// Do not reveal filesystem paths or private material in an error. The
			// successful response remains limited to this explicit requested ref.
			result.Success = false
			result.Error = "requested legacy certificate is unavailable"
			return
		}
		response.Certificates = append(response.Certificates, legacyCertificateExport{
			CertID: certID, CertPem: certPem, KeyPem: keyPem, ChainPem: chainPem,
		})
	}
	data, err := json.Marshal(response)
	if err != nil {
		result.Success = false
		result.Error = "legacy certificate export serialization failed"
		return
	}
	result.Data = data
}

func (h *Handler) handleRemoveCertificateReplica(cmd *pb.RemoveCertificateReplicaCommand, result *pb.CommandResult) {
	if !isValidCertificateID(cmd.CertId) || (cmd.ExpectedVersion != "" && !certificateVersionRegex.MatchString(cmd.ExpectedVersion)) || !replicaGenerationRegex.MatchString(cmd.ExpectedReplicaGeneration) {
		result.Success = false
		result.Error = "invalid certificate replica identifier"
		return
	}
	if err := nginx.RemoveCertificateReplica(h.cfg.Nginx.CertsDir, cmd.CertId, cmd.ExpectedVersion, cmd.ExpectedReplicaGeneration); err != nil {
		result.Success = false
		result.Error = "certificate replica removal failed"
		return
	}
	h.logger.Info("certificate replica removed", "cert_id", cmd.CertId)
}

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
		result.Success = false
		result.Error = fmt.Sprintf("nginx config test failed: %s", output)
		return
	}

	if err := h.mgr.Reload(); err != nil {
		rollback()
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
	backup, _ := nginx.ReadFile(h.cfg.Nginx.GlobalConfig)

	if err := nginx.WriteAtomic(h.cfg.Nginx.GlobalConfig, []byte(cmd.Content)); err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("write global config: %v", err)
		return
	}

	valid, output := h.mgr.TestConfig()
	result.Detail = output
	if !valid {
		// Rollback
		if backup != nil {
			nginx.WriteAtomic(h.cfg.Nginx.GlobalConfig, backup)
		}
		result.Success = false
		result.Error = fmt.Sprintf("nginx config test failed: %s", output)
		return
	}

	if err := h.mgr.Reload(); err != nil {
		if backup != nil {
			nginx.WriteAtomic(h.cfg.Nginx.GlobalConfig, backup)
		}
		result.Success = false
		result.Error = fmt.Sprintf("nginx reload failed: %v", err)
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

func (h *Handler) handleRequestTrafficStats(cmd *pb.RequestTrafficStatsCommand, result *pb.CommandResult) {
	tailLines := int(cmd.TailLines)
	if tailLines <= 0 {
		tailLines = 200
	}
	if tailLines > 100_000 {
		tailLines = 100_000
	}
	hostID := strings.TrimSpace(cmd.HostId)
	if hostID != "" && !isValidUUID(hostID) {
		result.Success = false
		result.Error = "invalid proxy host id"
		return
	}
	windowSeconds := int(cmd.WindowSeconds)
	if windowSeconds < 0 {
		windowSeconds = 0
	}
	if windowSeconds > 300 {
		windowSeconds = 300
	}

	type statusCodes struct {
		S2xx int `json:"s2xx"`
		S3xx int `json:"s3xx"`
		S4xx int `json:"s4xx"`
		S5xx int `json:"s5xx"`
	}
	type trafficStats struct {
		HostID            string      `json:"hostId,omitempty"`
		StatusCodes       statusCodes `json:"statusCodes"`
		AvgResponseTime   float64     `json:"avgResponseTime"`
		P95ResponseTime   float64     `json:"p95ResponseTime"`
		TotalRequests     int         `json:"totalRequests"`
		TotalBytes        int64       `json:"totalBytes"`
		RequestsPerSecond float64     `json:"requestsPerSecond"`
		BytesPerSecond    float64     `json:"bytesPerSecond"`
		BusiestClientRPS  int         `json:"busiestClientRps"`
		WindowSeconds     float64     `json:"windowSeconds"`
		SampleTruncated   bool        `json:"sampleTruncated"`
		LastRequestAt     string      `json:"lastRequestAt,omitempty"`
	}
	stats := trafficStats{HostID: hostID, WindowSeconds: float64(windowSeconds)}
	writeStats := func() {
		encoded, err := json.Marshal(stats)
		if err != nil {
			result.Success = false
			result.Error = "encode traffic stats"
			return
		}
		result.Detail = string(encoded)
	}

	logPaths := make([]string, 0, 1)
	if hostID != "" {
		logPaths = append(logPaths, filepath.Join(h.cfg.Nginx.LogsDir, fmt.Sprintf("proxy-%s.access.log", hostID)))
	} else {
		entries, err := os.ReadDir(h.cfg.Nginx.LogsDir)
		if err != nil {
			writeStats()
			return
		}
		for _, entry := range entries {
			if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".access.log") {
				logPaths = append(logPaths, filepath.Join(h.cfg.Nginx.LogsDir, entry.Name()))
			}
		}
	}

	now := time.Now()
	cutoff := now.Add(-time.Duration(windowSeconds) * time.Second)
	latencies := make([]float64, 0, min(tailLines, 4096))
	clientSeconds := make(map[string]int)
	var firstRequest time.Time
	var lastRequest time.Time
	for _, logPath := range logPaths {
		lines, err := nginx.TailLastN(logPath, tailLines)
		if err != nil {
			continue
		}
		reachedWindowStart := false
		for _, line := range lines {
			parsed := nginx.ParseLogLine("", line)
			if parsed.Status == 0 {
				continue
			}
			requestAt, timestampErr := time.Parse("02/Jan/2006:15:04:05 -0700", parsed.Timestamp)
			if windowSeconds > 0 && timestampErr == nil && requestAt.Before(cutoff) {
				reachedWindowStart = true
				continue
			}
			if timestampErr == nil && requestAt.After(lastRequest) {
				lastRequest = requestAt
			}
			if timestampErr == nil && (firstRequest.IsZero() || requestAt.Before(firstRequest)) {
				firstRequest = requestAt
			}
			stats.TotalRequests++
			stats.TotalBytes += parsed.BodyBytesSent
			switch {
			case parsed.Status >= 200 && parsed.Status < 300:
				stats.StatusCodes.S2xx++
			case parsed.Status >= 300 && parsed.Status < 400:
				stats.StatusCodes.S3xx++
			case parsed.Status >= 400 && parsed.Status < 500:
				stats.StatusCodes.S4xx++
			case parsed.Status >= 500:
				stats.StatusCodes.S5xx++
			}
			if seconds, ok := parseNginxDuration(parsed.UpstreamResponseTime); ok {
				latencies = append(latencies, seconds)
			}
			if parsed.RemoteAddr != "" && timestampErr == nil {
				key := parsed.RemoteAddr + "\x00" + requestAt.Format(time.RFC3339)
				clientSeconds[key]++
				if clientSeconds[key] > stats.BusiestClientRPS {
					stats.BusiestClientRPS = clientSeconds[key]
				}
			}
		}
		if windowSeconds > 0 && len(lines) >= tailLines && !reachedWindowStart {
			stats.SampleTruncated = true
		}
	}

	if len(latencies) > 0 {
		var total float64
		for _, latency := range latencies {
			total += latency
		}
		stats.AvgResponseTime = total / float64(len(latencies))
		sort.Float64s(latencies)
		index := (len(latencies)*95 + 99) / 100
		stats.P95ResponseTime = latencies[max(0, index-1)]
	}
	if windowSeconds > 0 {
		if stats.SampleTruncated && !firstRequest.IsZero() && !lastRequest.IsZero() {
			stats.WindowSeconds = max(1, lastRequest.Sub(firstRequest).Seconds())
		}
		stats.RequestsPerSecond = float64(stats.TotalRequests) / stats.WindowSeconds
		stats.BytesPerSecond = float64(stats.TotalBytes) / stats.WindowSeconds
	}
	if !lastRequest.IsZero() {
		stats.LastRequestAt = lastRequest.UTC().Format(time.RFC3339)
	}
	writeStats()
}

func parseNginxDuration(value string) (float64, bool) {
	for _, candidate := range strings.Split(value, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" || candidate == "-" {
			continue
		}
		seconds, err := strconv.ParseFloat(candidate, 64)
		if err == nil && seconds >= 0 {
			return seconds, true
		}
	}
	return 0, false
}

func (h *Handler) handleSetDaemonLogStream(cmd *pb.SetDaemonLogStreamCommand, result *pb.CommandResult) {
	// Enable BEFORE logging so the forwarder picks up this message
	stream.SetDaemonLogStreaming(cmd.Enabled, cmd.MinLevel)
	h.logger.Info("daemon log stream enabled", "min_level", cmd.MinLevel)
}
