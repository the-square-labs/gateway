//go:build !linux

package nginx

import (
	"errors"
)

func prepareOpenRCPIDDirectory(string) error { return nil }

func readTrustedPIDFile(path string) ([]byte, error) {
	return nil, errors.New("trusted nginx pid identity requires Linux")
}

func createPIDDirectory(string) error {
	return errors.New("nginx pid repairs require Linux")
}

func removeForeignEmptyPIDFile(string) error {
	return errors.New("nginx pid repairs require Linux")
}
