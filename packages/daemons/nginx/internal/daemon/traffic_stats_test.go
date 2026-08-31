package daemon

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/config"
)

func TestRequestTrafficStatsScopesMetricsToProxyHost(t *testing.T) {
	logsDir := t.TempDir()
	hostID := "11111111-1111-4111-8111-111111111111"
	timestamp := time.Now().Format("02/Jan/2006:15:04:05 -0700")
	line := func(address string, status, bytes int, upstream string) string {
		return fmt.Sprintf(`%s - - [%s] "GET / HTTP/1.1" %d %d "-" "agent" %s 0.100`, address, timestamp, status, bytes, upstream)
	}
	content := line("192.0.2.10", 200, 100, "0.010") + "\n" + line("192.0.2.10", 503, 300, "0.200") + "\n"
	if err := os.WriteFile(filepath.Join(logsDir, "proxy-"+hostID+".access.log"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(logsDir, "proxy-22222222-2222-4222-8222-222222222222.access.log"), []byte(line("198.51.100.1", 404, 500, "0.500")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	handler := &Handler{cfg: &config.Config{Nginx: config.NginxConfig{LogsDir: logsDir}}}
	result := &pb.CommandResult{Success: true}
	handler.handleRequestTrafficStats(&pb.RequestTrafficStatsCommand{HostId: hostID, TailLines: 100, WindowSeconds: 15}, result)
	if !result.Success {
		t.Fatalf("traffic stats failed: %s", result.Error)
	}
	var stats struct {
		HostID            string  `json:"hostId"`
		TotalRequests     int     `json:"totalRequests"`
		TotalBytes        int64   `json:"totalBytes"`
		P95ResponseTime   float64 `json:"p95ResponseTime"`
		BusiestClientRPS  int     `json:"busiestClientRps"`
		RequestsPerSecond float64 `json:"requestsPerSecond"`
		StatusCodes       struct {
			S2xx int `json:"s2xx"`
			S5xx int `json:"s5xx"`
		} `json:"statusCodes"`
	}
	if err := json.Unmarshal([]byte(result.Detail), &stats); err != nil {
		t.Fatal(err)
	}
	if stats.HostID != hostID || stats.TotalRequests != 2 || stats.TotalBytes != 400 {
		t.Fatalf("unexpected scoped traffic stats: %#v", stats)
	}
	if stats.StatusCodes.S2xx != 1 || stats.StatusCodes.S5xx != 1 || stats.BusiestClientRPS != 2 {
		t.Fatalf("unexpected status/client counters: %#v", stats)
	}
	if stats.P95ResponseTime != 0.2 || stats.RequestsPerSecond <= 0 {
		t.Fatalf("unexpected rates/latency: %#v", stats)
	}
}

func TestRequestTrafficStatsRejectsInvalidHostID(t *testing.T) {
	handler := &Handler{cfg: &config.Config{Nginx: config.NginxConfig{LogsDir: t.TempDir()}}}
	result := &pb.CommandResult{Success: true}
	handler.handleRequestTrafficStats(&pb.RequestTrafficStatsCommand{HostId: "../all"}, result)
	if result.Success || result.Error != "invalid proxy host id" {
		t.Fatalf("invalid host id was accepted: %#v", result)
	}
}

func TestRequestTrafficStatsUpdatesReporterRatesOnlyForGlobalSamples(t *testing.T) {
	logsDir := t.TempDir()
	timestamp := time.Now().Format("02/Jan/2006:15:04:05 -0700")
	content := fmt.Sprintf("192.0.2.1 - - [%s] \"GET / HTTP/1.1\" 200 10 \"-\" \"agent\" 0.010 0.010\n", timestamp) +
		fmt.Sprintf("192.0.2.1 - - [%s] \"GET / HTTP/1.1\" 404 10 \"-\" \"agent\" 0.010 0.010\n", timestamp) +
		fmt.Sprintf("192.0.2.1 - - [%s] \"GET / HTTP/1.1\" 503 10 \"-\" \"agent\" 0.010 0.010\n", timestamp)
	if err := os.WriteFile(filepath.Join(logsDir, "proxy-11111111-1111-4111-8111-111111111111.access.log"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	reporter := &Reporter{}
	handler := &Handler{cfg: &config.Config{Nginx: config.NginxConfig{LogsDir: logsDir}}, reporter: reporter}
	result := &pb.CommandResult{Success: true}
	handler.handleRequestTrafficStats(&pb.RequestTrafficStatsCommand{TailLines: 100}, result)
	if !result.Success {
		t.Fatalf("traffic stats failed: %s", result.Error)
	}
	reporter.mu.RLock()
	rate4xx, rate5xx := reporter.rate4xx, reporter.rate5xx
	reporter.mu.RUnlock()
	if rate4xx < 33.3 || rate4xx > 33.4 || rate5xx < 33.3 || rate5xx > 33.4 {
		t.Fatalf("unexpected reporter rates: 4xx=%f 5xx=%f", rate4xx, rate5xx)
	}
}
