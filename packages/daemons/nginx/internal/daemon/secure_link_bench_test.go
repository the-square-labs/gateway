//go:build slbench

package daemon

// Load benchmark of the Secure Link listener with a real nginx (B-22). Built
// only with -tags slbench and run in two containers sharing a network
// namespace:
//
//	role daemon (one CPU, nginx image): nginx proxies :8080 to a Secure Link
//	  socket served by a sourceLinkManager with the production peer check
//	  against nginx's real master PID; each connection is bridged to the
//	  driver's backend.
//	role driver (other CPUs): the backend on 127.0.0.1:9000 and an
//	  open-loop load generator against :8080, stage by stage.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/nginx-daemon/internal/nginx"
)

const benchLinkID = "11111111-1111-4111-8111-111111111111"

func TestSecureLinkBenchDaemon(t *testing.T) {
	if os.Getenv("SLBENCH_ROLE") != "daemon" {
		t.Skip("SLBENCH_ROLE=daemon")
	}
	keepalive := os.Getenv("SLBENCH_KEEPALIVE") != "0"
	upstreamOptions := "keepalive 64;"
	locationOptions := "proxy_http_version 1.1; proxy_set_header Connection \"\";"
	if !keepalive {
		// Every request opens a new connection to the Secure Link socket.
		upstreamOptions, locationOptions = "", "proxy_http_version 1.0;"
	}
	config := fmt.Sprintf(`user nginx;
worker_processes 1;
pid /run/bench-nginx.pid;
error_log /tmp/bench-nginx-error.log warn;
events { worker_connections 16384; }
http {
  access_log off;
  upstream secure_link { server unix:/run/gateway-secure-links/%s.sock max_fails=0; %s }
  server {
    listen 8080 backlog=4096;
    location / { proxy_pass http://secure_link; %s proxy_connect_timeout 3s; proxy_read_timeout 10s; }
  }
}
`, benchLinkID, upstreamOptions, locationOptions)
	if err := os.WriteFile("/etc/nginx/bench.conf", []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command("nginx", "-c", "/etc/nginx/bench.conf").CombinedOutput(); err != nil {
		t.Fatalf("start nginx: %v %s", err, output)
	}
	defer exec.Command("nginx", "-c", "/etc/nginx/bench.conf", "-s", "stop").Run()
	time.Sleep(300 * time.Millisecond)
	manager := nginx.NewManager("nginx", "", "", "/etc/nginx/bench.conf")
	backend := os.Getenv("SLBENCH_BACKEND")
	links := newSourceLinkManagerAt(func(_ string, connection net.Conn) {
		defer connection.Close()
		upstream, err := net.DialTimeout("tcp", backend, 3*time.Second)
		if err != nil {
			return
		}
		defer upstream.Close()
		benchEstablished(connection)
		done := make(chan struct{}, 2)
		go func() { _, _ = io.Copy(upstream, connection); done <- struct{}{} }()
		go func() { _, _ = io.Copy(connection, upstream); done <- struct{}{} }()
		<-done
	}, "/run/gateway-secure-links", "nginx", benchMasterPID(manager))
	if _, err := links.sync(benchCommand()); err != nil {
		t.Fatal(err)
	}
	fmt.Println("SLBENCH daemon ready")
	duration, _ := time.ParseDuration(os.Getenv("SLBENCH_DURATION"))
	if duration == 0 {
		duration = 10 * time.Minute
	}
	deadline := time.After(duration)
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-deadline:
			return
		case <-ticker.C:
			if _, err := os.Stat("/run/slbench-stop"); err == nil {
				return
			}
			out, _ := exec.Command("sh", "-c", "ss -xl | grep gateway-secure-links | awk '{print $3}'").Output()
			fmt.Printf("SLBENCH backlog=%s shed=%d\n", strings.TrimSpace(string(out)), benchShed(links))
		}
	}
}

type benchStage struct {
	Rate     int     `json:"rate"`
	Seconds  int     `json:"seconds"`
	Sent     int64   `json:"sent"`
	OK       int64   `json:"ok"`
	Failed   int64   `json:"failed"`
	P50ms    float64 `json:"p50_ms"`
	P99ms    float64 `json:"p99_ms"`
	Achieved float64 `json:"achieved_rps"`
}

func TestSecureLinkBenchDriver(t *testing.T) {
	if os.Getenv("SLBENCH_ROLE") != "driver" {
		t.Skip("SLBENCH_ROLE=driver")
	}
	backend := &http.Server{Addr: "127.0.0.1:9000", Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok\n"))
	})}
	go func() { _ = backend.ListenAndServe() }()
	defer backend.Close()
	client := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{
		MaxIdleConns: 4096, MaxIdleConnsPerHost: 4096, IdleConnTimeout: time.Minute,
	}}
	for deadline := time.Now().Add(30 * time.Second); ; {
		if response, err := client.Get("http://127.0.0.1:8080/"); err == nil {
			response.Body.Close()
			if response.StatusCode == 200 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("nginx never answered through the Secure Link")
		}
		time.Sleep(200 * time.Millisecond)
	}
	var stages []benchStage
	for _, spec := range strings.Split(os.Getenv("SLBENCH_STAGES"), ",") {
		parts := strings.Split(spec, ":")
		rate, _ := strconv.Atoi(parts[0])
		seconds, _ := strconv.Atoi(parts[1])
		stage := runBenchStage(client, rate, seconds)
		stages = append(stages, stage)
		encoded, _ := json.Marshal(stage)
		fmt.Printf("SLBENCH stage %s\n", encoded)
	}
}

func runBenchStage(client *http.Client, rate, seconds int) benchStage {
	stage := benchStage{Rate: rate, Seconds: seconds}
	var ok, failed atomic.Int64
	var mu sync.Mutex
	latencies := make([]float64, 0, rate*seconds)
	var wg sync.WaitGroup
	interval := time.Second / time.Duration(rate)
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(seconds)*time.Second)
	defer cancel()
	next := started
	for ctx.Err() == nil {
		next = next.Add(interval)
		if wait := time.Until(next); wait > 0 {
			time.Sleep(wait)
		}
		stage.Sent++
		wg.Add(1)
		go func() {
			defer wg.Done()
			begin := time.Now()
			response, err := client.Get("http://127.0.0.1:8080/")
			if err == nil {
				_, _ = io.Copy(io.Discard, response.Body)
				response.Body.Close()
			}
			if err != nil || response.StatusCode != 200 {
				failed.Add(1)
				return
			}
			ok.Add(1)
			mu.Lock()
			latencies = append(latencies, float64(time.Since(begin).Microseconds())/1000)
			mu.Unlock()
		}()
	}
	wg.Wait()
	stage.OK, stage.Failed = ok.Load(), failed.Load()
	stage.Achieved = float64(stage.OK) / time.Since(started).Seconds()
	sort.Float64s(latencies)
	if n := len(latencies); n > 0 {
		stage.P50ms, stage.P99ms = latencies[n/2], latencies[n*99/100]
	}
	return stage
}

func benchCommand() *pbSyncCommand { return sourceCommandFor(benchLinkID) }
