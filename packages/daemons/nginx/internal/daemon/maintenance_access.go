package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
)

const maintenanceAccessSocketPath = "/run/nginx-daemon/maintenance-access.sock"

var maintenanceAccessHostID = regexp.MustCompile(`^[0-9a-fA-F-]{36}$`)

type maintenanceAccessServer struct {
	listener net.Listener
	server   *http.Server
}

func startMaintenanceAccessServer(conn *grpc.ClientConn, logger interface{ Warn(string, ...any) }) (*maintenanceAccessServer, error) {
	if err := os.MkdirAll(filepath.Dir(maintenanceAccessSocketPath), 0o755); err != nil {
		return nil, err
	}
	if info, err := os.Lstat(maintenanceAccessSocketPath); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, errors.New("refusing to replace non-socket maintenance access path")
		}
		if err := os.Remove(maintenanceAccessSocketPath); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}

	listener, err := net.Listen("unix", maintenanceAccessSocketPath)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(maintenanceAccessSocketPath, 0o666); err != nil {
		_ = listener.Close()
		_ = os.Remove(maintenanceAccessSocketPath)
		return nil, err
	}

	client := pb.NewMaintenanceAccessClient(conn)
	mux := http.NewServeMux()
	mux.HandleFunc("/redeem/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		hostID := strings.TrimPrefix(r.URL.Path, "/redeem/")
		if !maintenanceAccessHostID.MatchString(hostID) || strings.Contains(hostID, "/") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 512)).Decode(&body); err != nil || len(body.Code) < 32 || len(body.Code) > 128 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		requestHost := r.Header.Get("X-Gateway-Maintenance-Host")
		if requestHost == "" {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		ctx = metadata.NewOutgoingContext(ctx, metadata.Pairs("x-gateway-maintenance-host", requestHost))
		reply, err := client.Redeem(ctx, &pb.MaintenanceAccessRedeemRequest{HostId: hostID, Code: body.Code})
		if err != nil {
			logger.Warn("maintenance access redemption failed", "error", err)
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		if !reply.Allowed || reply.SessionToken == "" {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		signature, expires, ok := strings.Cut(reply.SessionToken, ",")
		if !ok || signature == "" || expires == "" {
			logger.Warn("maintenance access redemption returned an invalid session token")
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		http.SetCookie(w, &http.Cookie{
			Name:     "gateway_maintenance_access_sig",
			Value:    signature,
			Path:     "/",
			MaxAge:   60 * 60,
			HttpOnly: true,
			Secure:   r.Header.Get("X-Gateway-Maintenance-Secure") == "on",
			SameSite: http.SameSiteLaxMode,
		})
		http.SetCookie(w, &http.Cookie{
			Name:     "gateway_maintenance_access_exp",
			Value:    expires,
			Path:     "/",
			MaxAge:   60 * 60,
			HttpOnly: true,
			Secure:   r.Header.Get("X-Gateway-Maintenance-Secure") == "on",
			SameSite: http.SameSiteLaxMode,
		})
		w.WriteHeader(http.StatusNoContent)
	})

	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Warn("maintenance access socket stopped", "error", err)
		}
	}()
	return &maintenanceAccessServer{listener: listener, server: server}, nil
}

func (s *maintenanceAccessServer) close() {
	if s == nil {
		return
	}
	_ = s.server.Close()
	_ = s.listener.Close()
	_ = os.Remove(maintenanceAccessSocketPath)
}
