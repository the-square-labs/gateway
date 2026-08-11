package main

import (
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/relay/internal/identity"
)

func TestRetryIdentityStartWaitsForProvisioning(t *testing.T) {
	attempts := 0
	sleeps := 0
	result, err := retryIdentityStart(
		func() (string, error) {
			attempts++
			if attempts == 1 {
				return "", fmt.Errorf("load relay identity: %w", os.ErrNotExist)
			}
			if attempts == 2 {
				return "", fmt.Errorf("load relay identity: %w", identity.ErrMaterialUpdating)
			}
			return "ready", nil
		},
		3,
		time.Second,
		func(time.Duration) { sleeps++ },
	)
	if err != nil || result != "ready" || attempts != 3 || sleeps != 2 {
		t.Fatalf("unexpected retry result: result=%q err=%v attempts=%d sleeps=%d", result, err, attempts, sleeps)
	}
}

func TestRetryIdentityStartFailsFastForPermanentErrors(t *testing.T) {
	permanent := errors.New("invalid relay configuration")
	attempts := 0
	_, err := retryIdentityStart(
		func() (string, error) {
			attempts++
			return "", permanent
		},
		30,
		time.Second,
		func(time.Duration) { t.Fatal("permanent errors must not sleep") },
	)
	if !errors.Is(err, permanent) || attempts != 1 {
		t.Fatalf("unexpected failure: err=%v attempts=%d", err, attempts)
	}
}
