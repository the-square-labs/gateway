package docker

import (
	"errors"
	"net/http"
	"testing"
	"time"
)

func TestRegistryReadIsSentAgainWhileTheRelayTunnelFails(t *testing.T) {
	previous := registryProxyRetryDelay
	registryProxyRetryDelay = time.Millisecond
	defer func() { registryProxyRetryDelay = previous }()

	request, _ := http.NewRequest(http.MethodGet, "http://registry.internal/v2/app/blobs/sha256:abc", nil)
	calls := 0
	response, err := roundTripRegistryRead(request, func(*http.Request) (*http.Response, error) {
		calls++
		if calls < 3 {
			return nil, errors.New("io: read/write on closed pipe")
		}
		return &http.Response{StatusCode: http.StatusOK}, nil
	})
	if err != nil || response.StatusCode != http.StatusOK || calls != 3 {
		t.Fatalf("read: calls=%d response=%v err=%v", calls, response, err)
	}

	calls = 0
	_, err = roundTripRegistryRead(request, func(*http.Request) (*http.Response, error) {
		calls++
		return nil, errors.New("relay is unavailable")
	})
	if err == nil || calls != registryProxyReadAttempts {
		t.Fatalf("read retries are bounded: calls=%d err=%v", calls, err)
	}
}

func TestRegistryWriteIsSentOnce(t *testing.T) {
	request, _ := http.NewRequest(http.MethodPut, "http://registry.internal/v2/app/blobs/uploads/1", nil)
	calls := 0
	if _, err := roundTripRegistryRead(request, func(*http.Request) (*http.Response, error) {
		calls++
		return nil, errors.New("relay is unavailable")
	}); err == nil || calls != 1 {
		t.Fatalf("write: calls=%d err=%v", calls, err)
	}
}
