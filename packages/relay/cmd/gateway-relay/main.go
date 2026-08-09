package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/relay/internal/config"
	"github.com/wiolett-industries/gateway/relay/internal/identity"
	"github.com/wiolett-industries/gateway/relay/internal/server"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

var buildVersion = "dev"

func main() {
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		if err := healthcheck(); err != nil {
			slog.Error("relay healthcheck failed", "error", err)
			os.Exit(1)
		}
		return
	}
	cfg, err := config.Load()
	if err != nil {
		fail(err)
	}
	runtime, err := server.Start(cfg, buildVersion)
	if err != nil {
		fail(err)
	}
	slog.Info("generic Gateway relay listening", "port", cfg.Port, "build_version", buildVersion, "protocol_major", 1)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	runtime.Stop()
}

func healthcheck() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	store, err := identity.NewStore(cfg.IdentityDir, cfg.StateDir)
	if err != nil {
		return err
	}
	current := store.Current()
	tlsConfig := &tls.Config{
		MinVersion:         tls.VersionTLS13,
		Certificates:       []tls.Certificate{current.AppClient},
		InsecureSkipVerify: true, // Verified below without imposing a hostname on the mounted public certificate.
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 {
				return fmt.Errorf("relay certificate missing")
			}
			_, err := state.PeerCertificates[0].Verify(x509.VerifyOptions{Roots: current.SystemCA, Intermediates: intermediates(state.PeerCertificates[1:]), KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
			return err
		},
	}
	connection, err := grpc.NewClient(fmt.Sprintf("127.0.0.1:%d", cfg.Port), grpc.WithTransportCredentials(credentials.NewTLS(tlsConfig)))
	if err != nil {
		return err
	}
	defer connection.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	response, err := relayv1.NewRelayAdminClient(connection).GetHealth(ctx, &relayv1.HealthRequest{})
	if err != nil {
		return err
	}
	return validateHealth(response)
}

func validateHealth(response *relayv1.HealthResponse) error {
	if !response.Liveness {
		return fmt.Errorf("relay is not live")
	}
	if !response.Readiness {
		return fmt.Errorf("relay is not ready: %s", response.Reason)
	}
	if response.ProtocolMajor != 1 || response.AppliedRevision == 0 || len(response.KeyIds) == 0 {
		return fmt.Errorf("relay policy contract is not ready")
	}
	return nil
}

func intermediates(certificates []*x509.Certificate) *x509.CertPool {
	pool := x509.NewCertPool()
	for _, certificate := range certificates {
		pool.AddCert(certificate)
	}
	return pool
}

func fail(err error) { slog.Error("relay failed", "error", err); os.Exit(1) }
