package docker

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	mobyclient "github.com/moby/moby/client"
)

// Native ClickHouse BACKUP runs inside the database, not inside our helper.
// Expose one run-owned HTTP bridge on that database's private network gateway;
// the bridge verifies MinIO TLS and permits only the owned database container.
func (r *backupRuntime) prepareBackupNativeS3(ctx context.Context, payload *backupPayload) (func(), error) {
	noop := func() {}
	if payload.Engine != "clickhouse" {
		return noop, nil
	}
	target := &payload.Destination
	owner := "storage_backup_target"
	if payload.Staging != nil {
		target = payload.Staging
		owner = "storage_backup_staging"
	}
	if target.RelayRouteID == "" {
		return noop, nil
	}
	database := &payload.Source
	if payload.Direction == "restore" {
		database = payload.RestoreTarget
	}
	if database == nil || database.ManagedDatabaseID == "" || r.plugin.databaseManager == nil {
		return nil, errors.New("external ClickHouse requires a server-reachable S3 staging connection for private storage")
	}
	manager := r.plugin.databaseManager
	manager.mu.Lock()
	record, err := manager.loadRecord(database.ManagedDatabaseID)
	manager.mu.Unlock()
	if err != nil || record.Type != "clickhouse" {
		return nil, errors.New("select the managed ClickHouse node as executor or configure server-reachable S3 staging")
	}
	inspected, err := r.plugin.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil || inspected.Container.NetworkSettings == nil || inspected.Container.Config == nil || inspected.Container.Config.Labels[managedDatabaseLabel] != record.ID {
		return nil, errors.New("managed ClickHouse network identity is unavailable")
	}
	endpoint := inspected.Container.NetworkSettings.Networks[record.NetworkName]
	if endpoint == nil || !endpoint.IPAddress.IsValid() {
		return nil, errors.New("managed ClickHouse container has no private address")
	}
	network, err := r.plugin.client.cli.NetworkInspect(ctx, record.NetworkName, mobyclient.NetworkInspectOptions{})
	if err != nil {
		return nil, errors.New("managed ClickHouse network is unavailable")
	}
	gateway := ""
	for _, ipam := range network.Network.IPAM.Config {
		if ipam.Gateway.IsValid() {
			gateway = ipam.Gateway.String()
			break
		}
	}
	if gateway == "" {
		return nil, errors.New("managed ClickHouse network gateway is unavailable")
	}
	relayAddress, closeRelay, err := OpenBackupRelayRouteForBackup(ctx, r.plugin, owner, target.RelayRouteID)
	if err != nil {
		return nil, err
	}
	upstreamURL, err := url.Parse(target.Endpoint)
	if err != nil {
		closeRelay()
		return nil, errors.New("invalid native S3 endpoint")
	}
	upstreamURL.Host = relayAddress
	transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
		MaxIdleConns: 16, IdleConnTimeout: 30 * time.Second, ResponseHeaderTimeout: 60 * time.Second}
	if upstreamURL.Scheme == "https" {
		roots := x509.NewCertPool()
		if target.CAPEM == "" || !roots.AppendCertsFromPEM([]byte(target.CAPEM)) {
			closeRelay()
			return nil, errors.New("native storage TLS CA is required")
		}
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots, ServerName: target.ServerName}
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(gateway, "0"))
	if err != nil {
		closeRelay()
		return nil, errors.New("bind native backup storage bridge")
	}
	proxy := httputil.NewSingleHostReverseProxy(upstreamURL)
	proxy.Transport = transport
	// Preserve the signed Host header. Only the TCP/TLS destination changes.
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		http.Error(w, "storage relay unavailable", http.StatusBadGateway)
	}
	allowedIP := endpoint.IPAddress.String()
	bucketPrefix := "/" + target.Bucket + "/"
	server := &http.Server{ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		peer, _, _ := net.SplitHostPort(request.RemoteAddr)
		if peer != allowedIP || (request.URL.Path != "/"+target.Bucket && !strings.HasPrefix(request.URL.Path, bucketPrefix)) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		proxy.ServeHTTP(w, request)
	})}
	bridgeCtx, cancel := context.WithCancel(ctx)
	go func() { <-bridgeCtx.Done(); _ = server.Close(); transport.CloseIdleConnections(); closeRelay() }()
	go func() { _ = server.Serve(listener) }()
	target.NativeEndpoint = "http://" + listener.Addr().String()
	return func() { cancel(); _ = server.Close(); transport.CloseIdleConnections(); closeRelay() }, nil
}
