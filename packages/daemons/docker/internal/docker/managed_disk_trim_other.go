//go:build !linux

package docker

import "errors"

// Trim is a Linux feature; managed instances run on Linux nodes only.
func trimFilesystem(string) (int64, error) {
	return 0, errors.New("trim is not supported on this platform")
}
