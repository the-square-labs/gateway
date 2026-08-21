package server

import (
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/relay/internal/admin"
	"github.com/wiolett-industries/gateway/relay/internal/broker"
	"github.com/wiolett-industries/gateway/relay/internal/codec"
	"github.com/wiolett-industries/gateway/relay/internal/config"
	"github.com/wiolett-industries/gateway/relay/internal/identity"
	"github.com/wiolett-industries/gateway/relay/internal/policy"
	"github.com/wiolett-industries/gateway/relay/internal/proxy"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/keepalive"
)

const (
	maxGatewayMessageBytes = 512 * 1024 * 1024
	clientKeepaliveMinTime = 20 * time.Second
)

type Runtime struct {
	GRPC     *grpc.Server
	Listener net.Listener
	State    *policy.Store
	Proxy    *proxy.Handler
}

func Start(cfg config.Config, buildVersion string) (*Runtime, error) {
	identityStore, err := identity.NewStore(cfg.IdentityDir, cfg.StateDir)
	if err != nil {
		return nil, fmt.Errorf("load relay identity: %w", err)
	}
	mode := relayv1.RelayMode_RELAY_MODE_LOCAL_COMBINED
	if cfg.Mode == config.ModeRemoteDataOnly {
		mode = relayv1.RelayMode_RELAY_MODE_REMOTE_DATA_ONLY
	}
	state, err := policy.OpenWithOptions(cfg.StateDir, policy.Options{Mode: mode, PoolID: cfg.PoolID, InstanceID: cfg.InstanceID})
	if err != nil {
		return nil, fmt.Errorf("open relay state: %w", err)
	}
	tunnelBroker := broker.New(state)
	var app *grpc.ClientConn
	var proxyHandler *proxy.Handler
	reloadUpstream := func() error { return nil }
	serverOptions := []grpc.ServerOption{
		grpc.Creds(credentials.NewTLS(identityStore.ServerTLSConfig())),
		grpc.ForceServerCodec(codec.Codec{}),
		grpc.MaxRecvMsgSize(maxGatewayMessageBytes), grpc.MaxSendMsgSize(maxGatewayMessageBytes),
		grpc.KeepaliveParams(keepalive.ServerParameters{Time: 30 * time.Second, Timeout: 10 * time.Second}),
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
			MinTime:             clientKeepaliveMinTime,
			PermitWithoutStream: true,
		}),
	}
	if cfg.Mode == config.ModeLocalCombined {
		serverName, targetErr := targetServerName(cfg.AppTarget)
		if targetErr != nil {
			state.Close()
			return nil, targetErr
		}
		connectApp := func() (*grpc.ClientConn, error) {
			return grpc.NewClient(cfg.AppTarget,
				grpc.WithTransportCredentials(credentials.NewTLS(identityStore.AppTLSConfig(serverName))),
				grpc.WithDefaultCallOptions(grpc.ForceCodec(codec.Codec{}), grpc.MaxCallRecvMsgSize(maxGatewayMessageBytes), grpc.MaxCallSendMsgSize(maxGatewayMessageBytes)),
			)
		}
		app, err = connectApp()
		if err != nil {
			state.Close()
			return nil, fmt.Errorf("create app client: %w", err)
		}
		proxyHandler = proxy.New(app, connectApp)
		reloadUpstream = proxyHandler.ReloadUpstream
		serverOptions = append(serverOptions, grpc.UnknownServiceHandler(proxyHandler.Handle))
	}
	grpcServer := grpc.NewServer(serverOptions...)
	relayv1.RegisterTunnelBrokerServer(grpcServer, tunnelBroker)
	relayv1.RegisterRelayAdminServer(grpcServer, admin.New(state, tunnelBroker, identityStore, reloadUpstream, buildVersion))
	listener, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", cfg.Port))
	if err != nil {
		if app != nil {
			app.Close()
		}
		state.Close()
		return nil, err
	}
	runtime := &Runtime{GRPC: grpcServer, Listener: listener, State: state, Proxy: proxyHandler}
	go func() { _ = grpcServer.Serve(listener) }()
	return runtime, nil
}

func (r *Runtime) Stop() {
	r.GRPCStop()
	if r.Proxy != nil {
		_ = r.Proxy.Close()
	}
	_ = r.State.Close()
}

func (r *Runtime) GRPCStop() { r.GRPC.GracefulStop() }

func targetServerName(target string) (string, error) {
	parsed, err := url.Parse("dns://" + target)
	if err != nil {
		return "", fmt.Errorf("invalid app target: %w", err)
	}
	host := parsed.Hostname()
	if host == "" {
		host = strings.Split(target, ":")[0]
	}
	return host, nil
}
