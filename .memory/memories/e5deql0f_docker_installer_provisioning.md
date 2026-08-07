---
{
  "id": "e5deql0f",
  "file_name": "e5deql0f_docker_installer_provisioning",
  "tags": [
    "docker",
    "installer",
    "provisioning"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1786049117386,
  "updated_at": 1786049117386
}
---
The top-level scripts/install.sh must bootstrap Docker on a fresh host instead of failing. It mirrors setup-docker-node.sh: detect supported Debian/Ubuntu/Fedora/CentOS/RHEL systems, install Docker CE from Docker's official repository together with the Compose v2 plugin, start the daemon, and then choose docker or sudo docker. Installer status messages must stay inside the guide rail UI; package command output belongs in the secured installer log.
