//go:build !linux

package handover

import (
	"errors"
	"os"
)

var errNoMemfd = errors.New("handover: sealed memory files need Linux")

func sealedFile([]byte) (*os.File, error) { return nil, errNoMemfd }

func readSealedFile(*os.File, int64) ([]byte, error) { return nil, errNoMemfd }
