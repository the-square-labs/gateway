//go:build !linux

package listenerkeep

const notifyOnBehalfSupported = false

func notifyCredentials(int) []byte { return nil }
