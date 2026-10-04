package docker

import (
	"net/http"
	"time"
)

// registryProxyReadAttempts bounds how often a registry read is sent again when
// its relay tunnel fails before a response arrives. A Relay Pool update
// recreates the local relay, which alone serves the internal registry, and a
// pull that asks during those few seconds must not fail for it. Docker itself
// retries a layer download that breaks after its response started.
const registryProxyReadAttempts = 5

// registryProxyRetryDelay grows with each attempt: 1 s, 2 s, 3 s, 4 s.
var registryProxyRetryDelay = time.Second

// roundTripRegistryRead sends the request and, for a read (GET or HEAD, which
// carry no body), sends it again while the tunnel fails before a response.
// Writes are sent once: a push may have reached the registry.
func roundTripRegistryRead(request *http.Request, roundTrip func(*http.Request) (*http.Response, error)) (*http.Response, error) {
	read := request.Method == http.MethodGet || request.Method == http.MethodHead
	for attempt := 1; ; attempt++ {
		response, err := roundTrip(request)
		if err == nil || !read || attempt >= registryProxyReadAttempts {
			return response, err
		}
		select {
		case <-request.Context().Done():
			return nil, err
		case <-time.After(time.Duration(attempt) * registryProxyRetryDelay):
		}
	}
}
