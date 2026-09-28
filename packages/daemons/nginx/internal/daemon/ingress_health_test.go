package daemon

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/nginx-daemon/internal/nginx"
)

func TestEvaluateIngressHealth(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name    string
		in      ingressHealthInputs
		serving bool
		reason  string
	}{
		{
			name:    "serves the applied generation",
			in:      ingressHealthInputs{nginxRunning: true, expected: 7, served: 7, servedKnown: true, now: now},
			serving: true,
		},
		{
			name:   "nginx is not running",
			in:     ingressHealthInputs{nginxRunning: false, expected: 7, served: 7, servedKnown: true, now: now},
			reason: "nginx is not running",
		},
		{
			name:   "nginx did not load the last reload",
			in:     ingressHealthInputs{nginxRunning: true, expected: 8, served: 7, servedKnown: true, now: now},
			reason: "nginx serves config generation 7, the daemon applied generation 8",
		},
		{
			name: "secure link sources without a relay transport",
			in: ingressHealthInputs{
				nginxRunning: true, expected: 3, served: 3, servedKnown: true, secureLinkSources: 2, now: now,
			},
			reason: "no relay transport is connected for 2 Secure Link source(s)",
		},
		{
			name: "secure link sources with a relay transport",
			in: ingressHealthInputs{
				nginxRunning: true, expected: 3, served: 3, servedKnown: true, secureLinkSources: 2,
				usableTransports: 1, now: now,
			},
			serving: true,
		},
		{
			name:    "an unverified generation does not fail the check",
			in:      ingressHealthInputs{nginxRunning: true, expected: 3, now: now},
			serving: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status := evaluateIngressHealth(tc.in)
			if status.Serving != tc.serving {
				t.Fatalf("serving = %v, want %v (%v)", status.Serving, tc.serving, status.Reasons)
			}
			if tc.serving && status.Status != "serving" {
				t.Fatalf("status = %q", status.Status)
			}
			if tc.reason != "" && !strings.Contains(strings.Join(status.Reasons, "; "), tc.reason) {
				t.Fatalf("reasons %v do not contain %q", status.Reasons, tc.reason)
			}
			if !status.CheckedAt.Equal(now) {
				t.Fatalf("checkedAt = %v", status.CheckedAt)
			}
		})
	}
}

func testResponder(in ingressHealthInputs) *ingressHealthResponder {
	responder := &ingressHealthResponder{logger: slog.Default()}
	responder.inputs = func(now time.Time) ingressHealthInputs {
		snapshot := in
		snapshot.now = now
		return snapshot
	}
	return responder
}

func TestIngressHealthResponderAnswersThroughNginx(t *testing.T) {
	responder := testResponder(ingressHealthInputs{nginxRunning: true, expected: 12})

	request := httptest.NewRequest(http.MethodGet, "/health", nil)
	request.Header.Set(nginx.IngressGenerationHeader, "12")
	recorder := httptest.NewRecorder()
	responder.serveHealth(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("cache control = %q", recorder.Header().Get("Cache-Control"))
	}
	var body ingressHealthStatus
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.Serving || !body.GenerationVerified || body.ServedGeneration != 12 {
		t.Fatalf("unexpected body %+v", body)
	}

	stale := httptest.NewRequest(http.MethodGet, "/health", nil)
	stale.Header.Set(nginx.IngressGenerationHeader, "11")
	recorder = httptest.NewRecorder()
	responder.serveHealth(recorder, stale)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("stale generation status = %d, want 503", recorder.Code)
	}
	// The health report uses the most recent generation nginx served.
	if current := responder.current(); current.Serving || current.ServedGeneration != 11 {
		t.Fatalf("current = %+v", current)
	}
}

func TestIngressHealthResponderMethods(t *testing.T) {
	responder := testResponder(ingressHealthInputs{nginxRunning: false, expected: 1})
	head := httptest.NewRecorder()
	responder.serveHealth(head, httptest.NewRequest(http.MethodHead, "/health", nil))
	if head.Code != http.StatusServiceUnavailable || head.Body.Len() != 0 {
		t.Fatalf("HEAD = %d with %d body bytes", head.Code, head.Body.Len())
	}
	post := httptest.NewRecorder()
	responder.serveHealth(post, httptest.NewRequest(http.MethodPost, "/health", nil))
	if post.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST = %d, want 405", post.Code)
	}
}

func TestIngressHealthReportMarksAFailedLocalProbe(t *testing.T) {
	responder := testResponder(ingressHealthInputs{nginxRunning: true, expected: 4})
	responder.lastSelfProbe = errTestProbe
	status := responder.current()
	if status.Serving || !strings.Contains(strings.Join(status.Reasons, ";"), "local health probe") {
		t.Fatalf("status = %+v", status)
	}
	responder.observed, responder.observedAt = 4, time.Now()
	if status := responder.current(); !status.Serving {
		t.Fatalf("a fresh observation should win over an older probe failure: %+v", status)
	}
}

type testProbeError struct{}

func (testProbeError) Error() string { return "connection refused" }

var errTestProbe error = testProbeError{}
