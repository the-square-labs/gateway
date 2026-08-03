package sysmetrics

import (
	"context"
	"net/netip"
	"sync"
	"sync/atomic"
	"testing"
)

func TestPublicIPDetectorRefreshCollectsBalancedEgressAddresses(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	detector := &PublicIPDetector{
		providers: []string{"one", "two", "three"},
		fetch: func(_ context.Context, _ string) (netip.Addr, error) {
			mu.Lock()
			defer mu.Unlock()
			calls++
			if calls%2 == 0 {
				return netip.MustParseAddr("1.1.1.1"), nil
			}
			return netip.MustParseAddr("8.8.8.8"), nil
		},
	}

	detector.refresh(context.Background())

	want := []string{"1.1.1.1", "8.8.8.8"}
	if got := detector.Addresses(); !slicesEqual(got, want) {
		t.Fatalf("expected %v, got %v", want, got)
	}
	if calls != publicIPMaxSamples*len(detector.providers) {
		t.Fatalf("expected expanded sampling, got %d calls", calls)
	}
}

func TestPublicIPDetectorRefreshUsesFullWindowForStableInitialSample(t *testing.T) {
	var calls atomic.Int32
	detector := &PublicIPDetector{
		providers: []string{"one", "two", "three"},
		fetch: func(_ context.Context, _ string) (netip.Addr, error) {
			calls.Add(1)
			return netip.MustParseAddr("8.8.8.8"), nil
		},
	}

	detector.refresh(context.Background())

	if got := detector.Addresses(); !slicesEqual(got, []string{"8.8.8.8"}) {
		t.Fatalf("expected stable address, got %v", got)
	}
	if int(calls.Load()) != publicIPMaxSamples*len(detector.providers) {
		t.Fatalf("expected full sampling window, got %d calls", calls.Load())
	}
}

func TestPublicIPDetectorPreservesLastSuccessOnFailure(t *testing.T) {
	detector := &PublicIPDetector{
		addresses: []string{"8.8.8.8"},
		providers: []string{"one"},
		fetch: func(_ context.Context, _ string) (netip.Addr, error) {
			return netip.Addr{}, context.DeadlineExceeded
		},
	}

	detector.refresh(context.Background())

	if got := detector.Addresses(); !slicesEqual(got, []string{"8.8.8.8"}) {
		t.Fatalf("expected last successful address, got %v", got)
	}
}

func TestIsPublicIPAddress(t *testing.T) {
	tests := []struct {
		address string
		want    bool
	}{
		{address: "8.8.8.8", want: true},
		{address: "2001:4860:4860::8888", want: true},
		{address: "10.0.0.1", want: false},
		{address: "fd00::1", want: false},
		{address: "169.254.10.1", want: false},
		{address: "fe80::1", want: false},
		{address: "127.0.0.1", want: false},
	}

	for _, test := range tests {
		t.Run(test.address, func(t *testing.T) {
			if got := isPublicIPAddress(netip.MustParseAddr(test.address)); got != test.want {
				t.Fatalf("expected %t, got %t", test.want, got)
			}
		})
	}
}

func slicesEqual(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
