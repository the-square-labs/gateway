---
{
  "id": "h0g48t5u",
  "file_name": "h0g48t5u_daemon_install_output",
  "tags": [
    "daemon",
    "installer",
    "terminal-output"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1785945635456,
  "updated_at": 1785945635456
}
---
Gateway daemon setup terminal-output rule: `setup-node.sh`, `setup-docker-node.sh`, and `setup-monitoring-node.sh` must redirect the invoked `*-daemon install` command's stdout and stderr to their existing `LOG_FILE` and surface failures via `die`. The Go daemon install command emits unstyled config/systemd lines; letting it inherit the TTY breaks the scripted guide rail and duplicates the wrapper's styled success message. The Gateway installer already follows this pattern through `run_quiet`.
