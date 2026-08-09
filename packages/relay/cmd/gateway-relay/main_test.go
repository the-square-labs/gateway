package main

import (
	"testing"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

func TestValidateHealthRequiresDurablePolicyReadiness(t *testing.T) {
	tests := []struct {
		name     string
		response *relayv1.HealthResponse
		wantErr  bool
	}{
		{name: "live but unready", response: &relayv1.HealthResponse{Liveness: true, Readiness: false, Reason: "policy_snapshot_required"}, wantErr: true},
		{name: "missing revision", response: &relayv1.HealthResponse{Liveness: true, Readiness: true, ProtocolMajor: 1, KeyIds: []string{"key-1"}}, wantErr: true},
		{name: "ready", response: &relayv1.HealthResponse{Liveness: true, Readiness: true, ProtocolMajor: 1, AppliedRevision: 7, KeyIds: []string{"key-1"}}, wantErr: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateHealth(test.response)
			if (err != nil) != test.wantErr {
				t.Fatalf("validateHealth() error = %v, wantErr %v", err, test.wantErr)
			}
		})
	}
}
