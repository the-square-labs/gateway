package docker

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
)

const (
	registryRelayOwnerKind = "registry_secure_link"
	registryProxyAddress   = "127.0.0.1"
	registryProxyPort      = 5443
	registryProxyServer    = "127.0.0.1"
)

var registryRepositoryPattern = regexp.MustCompile(`^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$`)

type registryProxyBinding struct {
	id            string
	role          string
	generation    uint64
	repository    string
	actions       map[string]struct{}
	authorization string
	expiresAt     time.Time
	active        map[net.Conn]struct{}
}

type dockerRegistryProxyManager struct {
	mu        sync.RWMutex
	plugin    *DockerPlugin
	directory string
	trustRoot string
	bindings  map[string]*registryProxyBinding
	listener  net.Listener
	server    *http.Server
	caPEM     []byte
	cert      tls.Certificate
}

type registryProxyStatus struct {
	Address    string `json:"address"`
	Port       int    `json:"port"`
	ServerName string `json:"serverName"`
	CAPEM      string `json:"caPem"`
	Bindings   int    `json:"bindings"`
}

func newDockerRegistryProxyManager(plugin *DockerPlugin) (*dockerRegistryProxyManager, error) {
	directory := filepath.Join(plugin.cfg.StateDir, "registry-proxy")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	manager := &dockerRegistryProxyManager{
		plugin: plugin, directory: directory, trustRoot: "/etc/docker/certs.d", bindings: map[string]*registryProxyBinding{},
	}
	if plugin.cfg.Docker.Mode == "builder" {
		manager.trustRoot = filepath.Join(plugin.cfg.StateDir, "builder-registry-trust")
	}
	if value := strings.TrimSpace(os.Getenv("GATEWAY_DOCKER_CERTS_DIR")); value != "" {
		manager.trustRoot = value
	}
	if err := manager.loadOrCreateIdentity(); err != nil {
		return nil, err
	}
	return manager, nil
}

func (m *dockerRegistryProxyManager) sync(command *pb.SyncDockerRegistryBindingsCommand) (registryProxyStatus, error) {
	if command == nil {
		return registryProxyStatus{}, errors.New("docker registry bindings are required")
	}
	now := time.Now()
	next := make(map[string]*registryProxyBinding, len(command.Bindings))
	repositories := map[string]struct{}{}
	for _, input := range command.Bindings {
		if input == nil || !proxySecureLinkIDPattern.MatchString(input.BindingId) || input.RelayOwnerKind != registryRelayOwnerKind || input.RelayOwnerId != input.BindingId {
			return registryProxyStatus{}, errors.New("invalid registry relay binding identity")
		}
		if input.LocalAddress != registryProxyAddress || input.LocalPort != registryProxyPort {
			return registryProxyStatus{}, errors.New("registry proxy endpoint is immutable")
		}
		if !registryRepositoryPattern.MatchString(input.Repository) {
			return registryProxyStatus{}, errors.New("invalid registry repository")
		}
		if _, exists := repositories[input.Repository]; exists {
			return registryProxyStatus{}, fmt.Errorf("duplicate registry repository %s", input.Repository)
		}
		repositories[input.Repository] = struct{}{}
		actions, err := validateRegistryBindingActions(input.Role, input.Actions)
		if err != nil {
			return registryProxyStatus{}, err
		}
		if err := validateRegistryBindingProfile(m.plugin.cfg.Docker.Mode, input.Role); err != nil {
			return registryProxyStatus{}, err
		}
		expiresAt := time.Unix(input.AuthorizationExpiresAtUnix, 0)
		if !strings.HasPrefix(input.Authorization, "Bearer ") || !expiresAt.After(now.Add(5*time.Second)) || expiresAt.After(now.Add(10*time.Minute)) {
			return registryProxyStatus{}, errors.New("registry authorization is missing, expired, or exceeds the maximum lifetime")
		}
		if current := m.currentBinding(input.BindingId); current != nil && input.Generation < current.generation {
			return registryProxyStatus{}, fmt.Errorf("stale registry binding generation for %s", input.BindingId)
		}
		next[input.BindingId] = &registryProxyBinding{
			id: input.BindingId, role: input.Role, generation: input.Generation, repository: input.Repository,
			actions: actions, authorization: input.Authorization, expiresAt: expiresAt, active: map[net.Conn]struct{}{},
		}
	}

	m.mu.Lock()
	for id, current := range m.bindings {
		if replacement := next[id]; replacement != nil {
			replacement.active = current.active
			continue
		}
		for connection := range current.active {
			_ = connection.Close()
		}
	}
	m.bindings = next
	shouldStart := len(next) > 0 && m.listener == nil
	shouldStop := len(next) == 0 && m.listener != nil
	m.mu.Unlock()

	if shouldStop {
		m.stopListener()
	}
	if shouldStart {
		if err := m.startListener(); err != nil {
			m.failClosed()
			return registryProxyStatus{}, err
		}
	}
	if len(next) > 0 {
		if err := m.installDockerTrust(); err != nil {
			m.failClosed()
			return registryProxyStatus{}, err
		}
	}
	return registryProxyStatus{Address: registryProxyAddress, Port: registryProxyPort, ServerName: registryProxyServer, CAPEM: string(m.caPEM), Bindings: len(next)}, nil
}

func validateRegistryBindingProfile(mode, role string) error {
	if mode == "builder" && role != "builder" {
		return errors.New("builder profile accepts only builder registry bindings")
	}
	if mode != "builder" && role != "runtime" && role != "mirror" {
		return errors.New("runtime profile accepts only runtime or mirror registry bindings")
	}
	return nil
}

func validateRegistryBindingActions(role string, values []string) (map[string]struct{}, error) {
	if role != "builder" && role != "runtime" && role != "mirror" {
		return nil, errors.New("registry binding role must be builder, runtime, or mirror")
	}
	actions := map[string]struct{}{}
	for _, action := range values {
		if action != "pull" && action != "push" {
			return nil, errors.New("registry binding action must be pull or push")
		}
		if role == "runtime" && action != "pull" {
			return nil, errors.New("runtime registry bindings are pull-only")
		}
		actions[action] = struct{}{}
	}
	if len(actions) == 0 {
		return nil, errors.New("registry binding requires at least one action")
	}
	return actions, nil
}

func (m *dockerRegistryProxyManager) currentBinding(id string) *registryProxyBinding {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.bindings[id]
}

func (m *dockerRegistryProxyManager) startListener() error {
	listener, err := net.Listen("tcp4", fmt.Sprintf("%s:%d", registryProxyAddress, registryProxyPort))
	if err != nil {
		return fmt.Errorf("listen for registry proxy: %w", err)
	}
	tlsListener := tls.NewListener(listener, &tls.Config{Certificates: []tls.Certificate{m.cert}, MinVersion: tls.VersionTLS13})
	server := &http.Server{Handler: http.HandlerFunc(m.serveHTTP), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
	m.mu.Lock()
	if m.listener != nil || len(m.bindings) == 0 {
		m.mu.Unlock()
		_ = tlsListener.Close()
		return nil
	}
	m.listener = tlsListener
	m.server = server
	m.mu.Unlock()
	go func() {
		if err := server.Serve(tlsListener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			m.plugin.logger.Error("registry proxy stopped", "error", err)
			m.failClosed()
		}
	}()
	return nil
}

func (m *dockerRegistryProxyManager) stopListener() {
	m.mu.Lock()
	server, listener := m.server, m.listener
	m.server, m.listener = nil, nil
	m.mu.Unlock()
	if server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = server.Shutdown(ctx)
		cancel()
	}
	if listener != nil {
		_ = listener.Close()
	}
}

func (m *dockerRegistryProxyManager) failClosed() {
	m.mu.Lock()
	bindings := m.bindings
	m.bindings = map[string]*registryProxyBinding{}
	m.mu.Unlock()
	for _, binding := range bindings {
		for connection := range binding.active {
			_ = connection.Close()
		}
	}
	m.stopListener()
}

func (m *dockerRegistryProxyManager) reconcileGrants() {
	m.mu.Lock()
	defer m.mu.Unlock()
	bundle := m.plugin.relayGrants.get()
	for _, binding := range m.bindings {
		if findRelayAssignment(bundle, "connect", registryRelayOwnerKind, binding.id) != nil {
			continue
		}
		for connection := range binding.active {
			_ = connection.Close()
		}
	}
}

func (m *dockerRegistryProxyManager) serveHTTP(response http.ResponseWriter, request *http.Request) {
	repository, action, ok := registryRequestScope(request.Method, request.URL.Path)
	if !ok {
		http.Error(response, "registry request is outside the configured repository scope", http.StatusForbidden)
		return
	}
	binding := m.bindingForRepository(repository, action)
	if binding == nil {
		http.Error(response, "registry authorization is unavailable", http.StatusServiceUnavailable)
		return
	}
	request = request.Clone(request.Context())
	request.URL.RawQuery = sanitizeRegistryProxyQuery(request.Method, request.URL.Path, request.URL.Query()).Encode()
	request.URL.Scheme = "http"
	request.URL.Host = "registry.internal"
	request.Host = "registry.internal"
	request.RequestURI = ""
	request.Header.Del("Authorization")
	request.Header.Set("Authorization", binding.authorization)
	request.Header.Del("Forwarded")
	request.Header.Del("X-Forwarded-For")
	transport := &http.Transport{
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return m.openRelayConnection(ctx, binding)
		},
	}
	defer transport.CloseIdleConnections()
	upstream, err := transport.RoundTrip(request)
	if err != nil {
		http.Error(response, "internal registry is unavailable", http.StatusBadGateway)
		return
	}
	defer upstream.Body.Close()
	for key, values := range upstream.Header {
		for _, value := range values {
			if strings.EqualFold(key, "Location") {
				value = rewriteRegistryLocation(value)
			}
			response.Header().Add(key, value)
		}
	}
	response.WriteHeader(upstream.StatusCode)
	_, _ = io.Copy(response, upstream.Body)
}

func sanitizeRegistryProxyQuery(method, path string, values url.Values) url.Values {
	next := make(url.Values, len(values))
	for key, items := range values {
		next[key] = append([]string(nil), items...)
	}
	if method == http.MethodPost && strings.HasSuffix(path, "/blobs/uploads/") {
		// BuildKit opportunistically asks the registry to mount a blob from a
		// different build repository. Builder credentials are deliberately scoped
		// to exactly one output repository, so forwarding that request produces an
		// auth challenge for the foreign source repository. Keep the boundary
		// fail-closed and force a normal upload into the authorized repository.
		next.Del("mount")
		next.Del("from")
	}
	return next
}

func rewriteRegistryLocation(value string) string {
	parsed, err := url.Parse(value)
	if err != nil || !parsed.IsAbs() || parsed.User != nil {
		return value
	}
	if parsed.Scheme != "http" || !strings.EqualFold(parsed.Hostname(), "registry.internal") {
		return value
	}
	if port := parsed.Port(); port != "" && port != "5000" {
		return value
	}
	parsed.Scheme = "https"
	parsed.Host = fmt.Sprintf("%s:%d", registryProxyAddress, registryProxyPort)
	return parsed.String()
}

func (m *dockerRegistryProxyManager) bindingForRepository(repository, action string) *registryProxyBinding {
	m.mu.RLock()
	defer m.mu.RUnlock()
	now := time.Now()
	for _, binding := range m.bindings {
		if repository != "" && binding.repository != repository {
			continue
		}
		if _, allowed := binding.actions[action]; !allowed && repository != "" {
			continue
		}
		if binding.expiresAt.After(now.Add(5 * time.Second)) {
			return binding
		}
	}
	return nil
}

func registryRequestScope(method, path string) (string, string, bool) {
	if path == "/v2/" || path == "/v2" {
		if method == http.MethodGet || method == http.MethodHead {
			return "", "pull", true
		}
		return "", "", false
	}
	if !strings.HasPrefix(path, "/v2/") || strings.Contains(path, "/_catalog") {
		return "", "", false
	}
	if method == http.MethodDelete {
		return "", "", false
	}
	remainder := strings.TrimPrefix(path, "/v2/")
	end := len(remainder)
	for _, marker := range []string{"/manifests/", "/blobs/", "/tags/", "/referrers/"} {
		if index := strings.Index(remainder, marker); index >= 0 && index < end {
			end = index
		}
	}
	if end == len(remainder) || !registryRepositoryPattern.MatchString(remainder[:end]) {
		return "", "", false
	}
	action := "pull"
	if method != http.MethodGet && method != http.MethodHead {
		action = "push"
	}
	return remainder[:end], action, true
}

func (m *dockerRegistryProxyManager) openRelayConnection(ctx context.Context, binding *registryProxyBinding) (net.Conn, error) {
	assignment := findRelayAssignment(m.plugin.relayGrants.get(), "connect", registryRelayOwnerKind, binding.id)
	if assignment == nil {
		return nil, errors.New("registry relay grant is unavailable")
	}
	candidates := relaybridge.PoolCandidates(assignment, false)
	if len(candidates) == 0 {
		candidates = []*pb.RelayDataCandidate{{RelayInstanceId: relaybridge.LegacyTargetID, Grant: assignment.Grant}}
	}
	for _, candidate := range m.plugin.orderRelayCandidates(candidates) {
		router := m.plugin.relayRouter(candidate.GetRelayInstanceId())
		if router == nil || candidate.GetGrant() == nil {
			continue
		}
		client, relaySide := net.Pipe()
		m.trackConnection(binding.id, client, true)
		go func() {
			defer relaySide.Close()
			_ = router.openSourceTunnel(relaySide, candidate.GetGrant())
		}()
		go func() {
			<-ctx.Done()
			_ = client.Close()
		}()
		return &trackedRegistryConnection{Conn: client, close: func() { m.trackConnection(binding.id, client, false) }}, nil
	}
	return nil, errors.New("registry relay lane is unavailable")
}

type trackedRegistryConnection struct {
	net.Conn
	once  sync.Once
	close func()
}

func (c *trackedRegistryConnection) Close() error {
	err := c.Conn.Close()
	c.once.Do(c.close)
	return err
}

func (m *dockerRegistryProxyManager) trackConnection(bindingID string, connection net.Conn, add bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	binding := m.bindings[bindingID]
	if binding == nil {
		_ = connection.Close()
		return
	}
	if add {
		binding.active[connection] = struct{}{}
	} else {
		delete(binding.active, connection)
	}
}

func (m *dockerRegistryProxyManager) installDockerTrust() error {
	directory := filepath.Join(m.trustRoot, fmt.Sprintf("%s:%d", registryProxyAddress, registryProxyPort))
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return fmt.Errorf("create Docker registry trust directory: %w", err)
	}
	return os.WriteFile(filepath.Join(directory, "ca.crt"), m.caPEM, 0o644)
}

func (m *dockerRegistryProxyManager) loadOrCreateIdentity() error {
	caPath := filepath.Join(m.directory, "ca.pem")
	certPath := filepath.Join(m.directory, "server.pem")
	keyPath := filepath.Join(m.directory, "server-key.pem")
	if caPEM, caErr := os.ReadFile(caPath); caErr == nil {
		if cert, certErr := tls.LoadX509KeyPair(certPath, keyPath); certErr == nil {
			m.caPEM, m.cert = caPEM, cert
			return nil
		}
	}
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serverKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	now := time.Now()
	caTemplate := &x509.Certificate{
		SerialNumber: randomSerial(), Subject: pkix.Name{CommonName: "Gateway Registry Proxy CA"},
		NotBefore: now.Add(-time.Minute), NotAfter: now.AddDate(10, 0, 0), IsCA: true,
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		return err
	}
	serverTemplate := &x509.Certificate{
		SerialNumber: randomSerial(), Subject: pkix.Name{CommonName: registryProxyServer},
		NotBefore: now.Add(-time.Minute), NotAfter: now.AddDate(2, 0, 0),
		IPAddresses: []net.IP{net.ParseIP(registryProxyAddress)}, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		KeyUsage: x509.KeyUsageDigitalSignature,
	}
	serverDER, err := x509.CreateCertificate(rand.Reader, serverTemplate, caTemplate, &serverKey.PublicKey, caKey)
	if err != nil {
		return err
	}
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
	serverPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: serverDER})
	serverKeyDER, err := x509.MarshalPKCS8PrivateKey(serverKey)
	if err != nil {
		return err
	}
	serverKeyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: serverKeyDER})
	for _, file := range []struct {
		path string
		data []byte
		mode os.FileMode
	}{{caPath, caPEM, 0o644}, {certPath, serverPEM, 0o644}, {keyPath, serverKeyPEM, 0o600}} {
		if err := os.WriteFile(file.path, file.data, file.mode); err != nil {
			return err
		}
	}
	cert, err := tls.X509KeyPair(serverPEM, serverKeyPEM)
	if err != nil {
		return err
	}
	m.caPEM, m.cert = caPEM, cert
	return nil
}

func randomSerial() *big.Int {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	value, err := rand.Int(rand.Reader, limit)
	if err != nil {
		return big.NewInt(time.Now().UnixNano())
	}
	return value
}

func (p *DockerPlugin) SyncDockerRegistryBindings(command *pb.SyncDockerRegistryBindingsCommand) (string, error) {
	if p.registryProxy == nil {
		return "", errors.New("docker registry proxy is unavailable")
	}
	status, err := p.registryProxy.sync(command)
	if err != nil {
		return "", err
	}
	p.reconcileRelayRegistrations()
	detail, err := json.Marshal(status)
	return string(detail), err
}

func sortedRegistryBindingIDs(bindings map[string]*registryProxyBinding) []string {
	ids := make([]string, 0, len(bindings))
	for id := range bindings {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
