package install

import (
	"context"
	"fmt"
	"io"
	"os/exec"
)

type Executor interface {
	Run(context.Context, string, ...string) error
}

type systemExecutor struct{ stdout, stderr io.Writer }

func (e systemExecutor) Run(ctx context.Context, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout, cmd.Stderr = e.stdout, e.stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s failed: %w", name, err)
	}
	return nil
}
