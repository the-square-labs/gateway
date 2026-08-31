//go:build !linux

package nginx

import (
	"errors"
	"time"
)

func readTrustedPIDFile(path string) ([]byte, time.Time, error) {
	return nil, time.Time{}, errors.New("trusted nginx pid identity requires Linux")
}
