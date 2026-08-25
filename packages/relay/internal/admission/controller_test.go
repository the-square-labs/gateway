package admission

import (
	"runtime"
	"testing"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

type fixedSampler struct{ pressure ResourcePressure }

func (s *fixedSampler) Sample() ResourcePressure { return s.pressure }

func newTestController(pressure uint32) (*Controller, *fixedSampler) {
	sampler := &fixedSampler{pressure: ResourcePressure{CPUPercent: pressure}}
	controller := NewWithSampler(sampler)
	controller.UpdatePolicy(&relayv1.AdmissionPolicy{
		Enabled:                    true,
		ProxyTargetPressurePercent: 70,
		DatabaseReservePercent:     20,
		HardPressurePercent:        95,
	})
	return controller, sampler
}

func TestHealthyRelayDoesNotLimitApplicationSize(t *testing.T) {
	controller, _ := newTestController(20)
	usage := Usage{ActiveProxy: 100_000, ProxyByRoute: map[string]uint64{"large": 100_000}}
	if err := controller.Admit(TrafficClassProxy, "large", usage); err != nil {
		t.Fatalf("healthy admission rejected: %v", err)
	}
}

func TestPressureThrottlesDominantProxyButAdmitsNewRoute(t *testing.T) {
	controller, _ := newTestController(72)
	// Warm the EWMA to the fixed pressure.
	for range 8 {
		_ = controller.Admit(TrafficClassDatabase, "database", Usage{})
	}
	usage := Usage{ActiveProxy: 10_000, ProxyByRoute: map[string]uint64{"large": 10_000}}
	if err := controller.Admit(TrafficClassProxy, "large", usage); err == nil {
		t.Fatal("dominant proxy route was admitted under pressure")
	}
	if err := controller.Admit(TrafficClassProxy, "new", usage); err != nil {
		t.Fatalf("new proxy route did not receive fair admission: %v", err)
	}
}

func TestDatabaseReserveRejectsProxyBeforeDatabase(t *testing.T) {
	controller, sampler := newTestController(92)
	for range 8 {
		_ = controller.Admit(TrafficClassDatabase, "database", Usage{})
	}
	if err := controller.Admit(TrafficClassProxy, "proxy", Usage{}); err == nil {
		t.Fatal("proxy was admitted inside database reserve")
	}
	if err := controller.Admit(TrafficClassDatabase, "database", Usage{}); err != nil {
		t.Fatalf("database did not receive reserved admission: %v", err)
	}
	sampler.pressure = ResourcePressure{CPUPercent: 100}
	for range 8 {
		_ = controller.Admit(TrafficClassProxy, "proxy", Usage{})
	}
	if err := controller.Admit(TrafficClassDatabase, "database", Usage{}); err == nil {
		t.Fatal("database bypassed the absolute hard-pressure cutoff")
	}
}

func TestRegistryUsesAnExplicitNonDatabaseTrafficClass(t *testing.T) {
	controller, _ := newTestController(92)
	for range 8 {
		_ = controller.Admit(TrafficClassDatabase, "database", Usage{})
	}
	if err := controller.Admit(TrafficClassRegistry, "registry", Usage{}); err == nil {
		t.Fatal("registry traffic bypassed the non-database pressure cutoff")
	}
	if err := controller.Admit("unknown", "route", Usage{}); err == nil {
		t.Fatal("unknown traffic class was admitted")
	}
}

func TestDisabledAdmissionNeverThrottles(t *testing.T) {
	controller, _ := newTestController(100)
	controller.UpdatePolicy(&relayv1.AdmissionPolicy{Enabled: false})
	if err := controller.Admit(TrafficClassProxy, "proxy", Usage{}); err != nil {
		t.Fatalf("disabled admission rejected a tunnel: %v", err)
	}
	if state := controller.GetSnapshot().State; state != "disabled" {
		t.Fatalf("state = %q", state)
	}
}

func TestUnlimitedMemoryReportsRelayUsageWithoutHostPressure(t *testing.T) {
	pressure, rss, heap, limit := memoryPressureForLimit(18*1024*1024, 6*1024*1024, []byte("max\n"))
	if pressure != 0 || rss != 18*1024*1024 || heap != 6*1024*1024 || limit != 0 {
		t.Fatalf("unexpected unlimited memory metrics: pressure=%d rss=%d heap=%d limit=%d", pressure, rss, heap, limit)
	}
}

func TestFiniteMemoryLimitUsesRelayRSS(t *testing.T) {
	pressure, rss, _, limit := memoryPressureForLimit(256, 128, []byte("1024\n"))
	if pressure != 25 || rss != 256 || limit != 1024 {
		t.Fatalf("unexpected limited memory metrics: pressure=%d rss=%d limit=%d", pressure, rss, limit)
	}
}

func TestCountCPUListUsesProcessAffinity(t *testing.T) {
	if got := countCPUList("1-2,11,13"); got != 4 {
		t.Fatalf("cpu count = %d", got)
	}
	if got := countCPUList("0-3,8-9"); got != 6 {
		t.Fatalf("cpu count = %d", got)
	}
	if got := countCPUList("3-1"); got != 0 {
		t.Fatalf("invalid cpu count = %d", got)
	}
}

func TestProcessCPUNanosecondsSamplesAllRuntimeThreads(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux procfs required")
	}
	if used, ok := processCPUNanoseconds(); !ok || used == 0 {
		t.Fatalf("process cpu sample unavailable: used=%d ok=%t", used, ok)
	}
}

func TestSnapshotReportsSmoothedProcessPressure(t *testing.T) {
	controller, sampler := newTestController(40)
	for range 8 {
		_ = controller.Admit(TrafficClassDatabase, "database", Usage{})
	}
	sampler.pressure = ResourcePressure{CPUPercent: 0}
	snapshot := controller.GetSnapshot()
	if snapshot.CPUPressurePercent == 0 || snapshot.CPUPressurePercent >= 40 {
		t.Fatalf("smoothed cpu pressure = %d", snapshot.CPUPressurePercent)
	}
}
