package daemon

import (
	"errors"
	"fmt"
	"log/slog"
	"regexp"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
	sharedstate "github.com/wiolett-industries/gateway/daemon-shared/state"
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
