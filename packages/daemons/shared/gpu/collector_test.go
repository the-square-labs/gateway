package gpu

import "testing"

func TestParseNVIDIAInventoryRejectsPartitionedAndExclusiveDevices(t *testing.T) {
	devices := parseNVIDIAInventory([]byte(`GPU-1, 0, NVIDIA GeForce RTX 3050, 00000000:01:00.0, Disabled, Default
GPU-2, 1, NVIDIA A100, 00000000:02:00.0, Enabled, Default
GPU-3, 2, NVIDIA T4, 00000000:03:00.0, Disabled, Exclusive_Process
GPU-4, 3, NVIDIA GeForce RTX 3050, 00000000:04:00.0, [N/A], Default
`))
	if len(devices) != 4 {
		t.Fatalf("expected 4 devices, got %d", len(devices))
	}
	if devices[0].ID != "nvidia:GPU-1" || devices[0].PCIAddress != "0000:01:00.0" || !devices[0].Attachable {
		t.Fatalf("unexpected normal device: %#v", devices[0])
	}
	if !devices[1].Partitioned || devices[1].Attachable {
		t.Fatalf("MIG device must be unavailable: %#v", devices[1])
	}
	if devices[2].Attachable || devices[2].UnavailableReason == "" {
		t.Fatalf("exclusive device must be unavailable: %#v", devices[2])
	}
	if !devices[3].Attachable || devices[3].Partitioned {
		t.Fatalf("[N/A] MIG mode must remain attachable: %#v", devices[3])
	}
}

func TestNVIDIATelemetryKeepsReportedZerosDistinctFromMissingMetrics(t *testing.T) {
	devices := parseNVIDIAInventory([]byte("GPU-1, 0, NVIDIA GeForce RTX 3050, 00000000:01:00.0, Disabled, Default\n"))
	applyNVIDIATelemetry(devices, []byte("GPU-1, 0, 8192, 0, 40, 0, 100, N/A, 0, Not Active\n"))
	report := devices[0].ToProto()
	available := make(map[string]bool)
	for _, metric := range report.AvailableMetrics {
		available[metric] = true
	}
	for _, metric := range []string{"utilization_percent", "memory_total_bytes", "memory_used_bytes", "power_watts", "throttled"} {
		if !available[metric] {
			t.Fatalf("expected metric %q to be available: %#v", metric, report.AvailableMetrics)
		}
	}
	if available["ecc_corrected_errors"] {
		t.Fatalf("N/A ECC metric must not be advertised")
	}
	if report.MemoryUsedBytes != 0 || report.PowerWatts != 0 || report.Throttled {
		t.Fatalf("reported zero values must be retained: %#v", report)
	}
}

func TestParseIntelBusyUsesObservedBusyFieldsOnly(t *testing.T) {
	value, ok := parseIntelBusy([]byte(`[{"engines":{"render busy":42.5,"copy busy":12.5},"period":{"duration":1000}}]`))
	if !ok || value != 42.5 {
		t.Fatalf("expected max GPU busy value, got %v, %v", value, ok)
	}
	if _, ok := parseIntelBusy([]byte(`[{"period":{"duration":1000}}]`)); ok {
		t.Fatal("missing busy data must remain unavailable")
	}
}
