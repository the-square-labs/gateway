package daemon

import (
	"bytes"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"time"

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
	reporter                    *Reporter
	// secureLinkListeners provides the Secure Link sockets a config references
	// before nginx loads it (M-2); nil when the daemon runs without them.
	secureLinkListeners interface {
		ensureReferencedListeners(config string) []string
	}
	// mutationMu serializes the changes to the nginx configuration: commands, the deferred reload and the
	// daemon's own background changes (see reload_coalescing.go).
	mutationMu    sync.Mutex
	deferredMu    sync.Mutex
	deferredTimer *time.Timer
	deferredSince time.Time
}

// prepareSecureLinkListeners runs before a config is tested and reloaded: every
// Secure Link socket it references that this daemon should provide listens
// first. Sockets it cannot provide are logged; nginx treats them as refused
// connections and moves to the next member.
func (h *Handler) prepareSecureLinkListeners(configs ...string) {
	if h.secureLinkListeners == nil {
		return
	}
	for _, config := range configs {
		if absent := h.secureLinkListeners.ensureReferencedListeners(config); len(absent) > 0 {
			h.logger.Debug("config references Secure Link sockets that do not listen now", "sockets", absent)
		}
	}
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
	h.mutationMu.Lock()
	defer h.mutationMu.Unlock()

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
		h.handlePagesInventory(payload.PagesInventory, result)
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

// logConfigTestFailure records the nginx -t output of a rejected change on the
// node, where it stays available even when Gateway stores only a summary.
func (h *Handler) logConfigTestFailure(action, output string, attrs ...any) {
	h.logger.Error("nginx config test failed", append([]any{"action", action, "output", strings.TrimSpace(output)}, attrs...)...)
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

	// Make-before-break (M-2): the sockets the new config proxies to listen
	// before nginx can load it.
	h.prepareSecureLinkListeners(cmd.ConfigContent)
	if !cmd.TestOnly && oldConfig != nil && bytes.Equal(oldConfig, []byte(cmd.ConfigContent)) {
		// nginx already runs this config: a reconnect resync must not reload it.
		if err := h.settleUnchanged(cmd.DeferReload); err != nil {
			result.Success = false
			result.Error = err.Error()
		}
		return
	}
	undoChange := func() {}
	if !cmd.TestOnly {
		if undoChange, err = h.mgr.BeginChange(); err != nil {
			restoreOwnership()
			result.Success = false
			result.Error = err.Error()
			return
		}
	}
	if err := nginx.WriteAtomic(path, []byte(cmd.ConfigContent)); err != nil {
		restoreOwnership()
		undoChange()
		result.Success = false
		result.Error = fmt.Sprintf("write config: %v", err)
		return
	}

	valid, output := h.mgr.TestConfig()
	result.Detail = output

	if !valid {
		h.logConfigTestFailure("apply proxy host config", output, "host_id", cmd.HostId)
		if rollbackConfig() == nil {
			undoChange()
		}
		restoreOwnership()
		_, _ = h.mgr.TestConfig()
		result.Success = false
		result.Error = fmt.Sprintf("nginx config test failed: %s", output)
		return
	}

	if cmd.TestOnly {
		// Test passed, don't reload. Restore old config.
		_ = rollbackConfig()
		restoreOwnership()
		_, _ = h.mgr.TestConfig()
		return
	}

	if err := h.commitChange(cmd.DeferReload); err != nil {
		rollbackErr := rollbackConfig()
		restoreOwnership()
		_, _ = h.mgr.TestConfig()
		result.Success = false
		if rollbackErr != nil {
			result.Error = fmt.Sprintf("nginx reload failed: %v; rollback config: %v", err, rollbackErr)
		} else {
			result.Error = fmt.Sprintf("nginx reload failed: %v", err)
		}
		return
	}
	h.logger.Info("config applied", "host_id", cmd.HostId, "reload_deferred", cmd.DeferReload)
}

func (h *Handler) handleRemoveConfig(cmd *pb.RemoveConfigCommand, result *pb.CommandResult) {
	path := h.mgr.ConfigPath(cmd.HostId)
	oldConfig, _ := nginx.ReadFile(path)
	if oldConfig == nil {
		// Nothing to remove: nginx does not serve the host from this node.
		removeHostCache(cmd.HostId)
		if err := h.settleUnchanged(false); err != nil {
			result.Success = false
			result.Error = err.Error()
		}
		return
	}
	if _, err := h.mgr.BeginChange(); err != nil {
		result.Success = false
		result.Error = err.Error()
		return
	}
	if err := nginx.RemoveFile(path); err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("remove config: %v", err)
		return
	}

	// Clean up cache directory
	removeHostCache(cmd.HostId)

	valid, output := h.mgr.TestConfig()
	result.Detail = output
	if !valid {
		h.logConfigTestFailure("remove proxy host config", output, "host_id", cmd.HostId)
		if oldConfig != nil {
			_ = nginx.WriteAtomic(path, oldConfig)
		}
		_, _ = h.mgr.TestConfig()
		result.Success = false
		result.Error = fmt.Sprintf("nginx config test failed after removal: %s", output)
		return
	}

	if err := h.reloadNow(); err != nil {
		if oldConfig != nil {
			_ = nginx.WriteAtomic(path, oldConfig)
		}
		_, _ = h.mgr.TestConfig()
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
