//go:build !linux

package nginx

import (
	"errors"
)

func readTrustedPIDFile(path string) ([]byte, error) {
	return nil, errors.New("trusted nginx pid identity requires Linux")
}
