//go:build !linux

package nginx

import (
	"errors"
)

func prepareOpenRCPIDDirectory(string) error { return nil }

func readTrustedPIDFile(path string) ([]byte, error) {
	return nil, errors.New("trusted nginx pid identity requires Linux")
}
