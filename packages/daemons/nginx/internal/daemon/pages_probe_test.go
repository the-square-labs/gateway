package daemon

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/nginx"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/pages"
)

func pagesProbeCommand() *pb.ProbePagesRouteCommand {
	return &pb.ProbePagesRouteCommand{
		RouteId:        testSecureLinkID,
		Domain:         "docs.example.com",
		Path:           "/health?source=gateway",
		ExpectedBody:   "healthy",
		BodyMatchMode:  "includes",
		TimeoutSeconds: 2,
	}
}

func TestProbePagesRouteUsesLocalTransportAndRealHost(t *testing.T) {
	requestSeen := make(chan *http.Request, 1)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requestSeen <- request.Clone(request.Context())
		_, _ = response.Write([]byte("route is healthy"))
	}))
	defer server.Close()
	command := pagesProbeCommand()
	detail, err := probePagesRoute(command, func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	})
	if err != nil {
		t.Fatal(err)
	}
	request := <-requestSeen
	if request.Host != command.Domain || request.URL.Path != "/health" || request.URL.Query().Get("source") != "gateway" {
		t.Fatalf("unexpected request: host=%q url=%q", request.Host, request.URL.String())
	}
	var result pagesProbeResult
	if err := json.Unmarshal([]byte(detail), &result); err != nil {
		t.Fatal(err)
	}
	if !result.OK || result.HTTPStatus != http.StatusOK {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestProbePagesRouteUsesTLSWithRouteSNI(t *testing.T) {
	sni := make(chan string, 1)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	}))
	server.TLS = &tls.Config{GetCertificate: func(info *tls.ClientHelloInfo) (*tls.Certificate, error) {
		sni <- info.ServerName
		return &server.TLS.Certificates[0], nil
	}}
	server.StartTLS()
	defer server.Close()
	command := pagesProbeCommand()
	command.Tls = true
	command.ExpectedBody = ""
	detail, err := probePagesRoute(command, func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	})
	if err != nil {
		t.Fatal(err)
	}
	if actual := <-sni; actual != command.Domain {
		t.Fatalf("SNI = %q, want %q", actual, command.Domain)
	}
	var result pagesProbeResult
	if err := json.Unmarshal([]byte(detail), &result); err != nil || !result.OK {
		t.Fatalf("unexpected result: %#v err=%v", result, err)
	}
}

func TestProbePagesRouteDoesNotFollowRedirects(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		if request.URL.Path == "/redirect" {
			http.Redirect(response, request, "/destination", http.StatusFound)
			return
		}
		response.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	command := pagesProbeCommand()
	command.Path = "/redirect"
	command.ExpectedStatus = http.StatusFound
	command.ExpectedBody = ""
	detail, err := probePagesRoute(command, func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	})
	if err != nil {
		t.Fatal(err)
	}
	var result pagesProbeResult
	if err := json.Unmarshal([]byte(detail), &result); err != nil || !result.OK || requests != 1 {
		t.Fatalf("unexpected redirect probe: result=%#v requests=%d err=%v", result, requests, err)
	}
}

func TestProbePagesRouteSkipsLargeBodyWithoutBodyExpectation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusOK)
		_, _ = response.Write(make([]byte, pagesProbeBodyLimit+1))
	}))
	defer server.Close()
	command := pagesProbeCommand()
	command.ExpectedBody = ""
	detail, err := probePagesRoute(command, func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	})
	if err != nil {
		t.Fatal(err)
	}
	var result pagesProbeResult
	if err := json.Unmarshal([]byte(detail), &result); err != nil || !result.OK {
		t.Fatalf("unexpected status-only probe: result=%#v err=%v", result, err)
	}
}

func TestNginxPluginProbePagesRouteUsesConfiguredCustomListenPort(t *testing.T) {
	hostSeen := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		hostSeen <- request.Host
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	port := server.Listener.Addr().(*net.TCPAddr).Port
	manager := nginx.NewManager("", t.TempDir(), "", "")
	config := fmt.Sprintf("server { listen %d; server_name docs.example.com; }", port)
	if err := os.WriteFile(manager.ConfigPath(testSecureLinkID), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	plugin := &NginxPlugin{mgr: manager, pagesRuntime: &pages.Runtime{}, pagesV1Available: true}
	command := pagesProbeCommand()
	command.ExpectedBody = ""
	command.ExpectedStatus = http.StatusNoContent
	detail, err := plugin.ProbePagesRoute(command)
	if err != nil {
		t.Fatal(err)
	}
	var result pagesProbeResult
	if err := json.Unmarshal([]byte(detail), &result); err != nil || !result.OK {
		t.Fatalf("unexpected custom-listen probe: result=%#v err=%v", result, err)
	}
	if host := <-hostSeen; host != "docs.example.com" {
		t.Fatalf("Host = %q, want docs.example.com", host)
	}
}

func TestPagesProbeListenAddressSelectsMatchingProtocolAndAddressFamily(t *testing.T) {
	config := []byte("server { listen 8080; listen [::]:8443 ssl; # listen 9999;\n }")
	httpAddress, err := pagesProbeListenAddress(config, false)
	if err != nil || httpAddress != "127.0.0.1:8080" {
		t.Fatalf("HTTP address = %q, err=%v", httpAddress, err)
	}
	httpsAddress, err := pagesProbeListenAddress(config, true)
	if err != nil || httpsAddress != "[::1]:8443" {
		t.Fatalf("HTTPS address = %q, err=%v", httpsAddress, err)
	}
}

func TestProbePagesRouteRejectsUnsafeInputs(t *testing.T) {
	for name, mutate := range map[string]func(*pb.ProbePagesRouteCommand){
		"wildcard domain": func(command *pb.ProbePagesRouteCommand) { command.Domain = "*.example.com" },
		"absolute URL":    func(command *pb.ProbePagesRouteCommand) { command.Path = "https://evil.example/" },
		"unknown matcher": func(command *pb.ProbePagesRouteCommand) { command.BodyMatchMode = "regex" },
		"invalid status":  func(command *pb.ProbePagesRouteCommand) { command.ExpectedStatus = 999 },
		"excess timeout":  func(command *pb.ProbePagesRouteCommand) { command.TimeoutSeconds = 31 },
	} {
		t.Run(name, func(t *testing.T) {
			command := pagesProbeCommand()
			mutate(command)
			if _, err := probePagesRoute(command, nil); err == nil {
				t.Fatal("unsafe probe input was accepted")
			}
		})
	}
}

func TestNormalizePagesProbeDomainAcceptsDNSCaseAndTrailingDot(t *testing.T) {
	domain, err := normalizePagesProbeDomain("Docs.Example.COM.")
	if err != nil {
		t.Fatal(err)
	}
	if domain != "docs.example.com" {
		t.Fatalf("domain = %q, want docs.example.com", domain)
	}
}
