#!/usr/bin/env sh
# Every Go module must build on its own (GOWORK=off), as the image and release
# builds do, from a tidy go.mod/go.sum: the workspace hides a module whose
# go.mod misses a requirement another workspace module brings in.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

"$SCRIPT_DIR/sync-update-trust-anchor.sh"

status=0
for dir in "$REPO_ROOT"/packages/daemons/*/ "$REPO_ROOT"/packages/relay/; do
  [ -f "$dir/go.mod" ] || continue
  name=${dir#"$REPO_ROOT"/}
  if ! (cd "$dir" && GOWORK=off go mod tidy -diff); then
    echo "$name: go.mod/go.sum are not tidy; run 'GOWORK=off go mod tidy' in $name" >&2
    status=1
  fi
  if ! (cd "$dir" && GOWORK=off go build -o /dev/null ./...); then
    echo "$name: does not build outside the Go workspace" >&2
    status=1
  fi
done
exit "$status"
