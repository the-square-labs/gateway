package leasefence

import (
	"bufio"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// DefaultCgroupRoot is where cgroupfs is mounted.
const DefaultCgroupRoot = "/sys/fs/cgroup"

// v1Controllers are probed on cgroup v1 hosts; any one holds every task.
var v1Controllers = []string{"pids", "memory", "cpu,cpuacct", "cpuacct", "cpu", "freezer", "devices", "blkio", "systemd"}

// CgroupCandidates lists the directories that may hold containerID's
// processes under root: the recorded hint when it is a valid path for this
// container, then Docker's systemd and cgroupfs layouts for cgroup v2 and v1.
// Callers act only on the ones that exist.
func CgroupCandidates(root, containerID, hint string) []string {
	if root == "" {
		root = DefaultCgroupRoot
	}
	if !ValidContainerID(containerID) {
		return nil
	}
	var out []string
	seen := map[string]bool{}
	add := func(path string) {
		if !seen[path] {
			seen[path] = true
			out = append(out, path)
		}
	}
	if ValidCgroupPath(root, containerID, hint) {
		add(filepath.Clean(hint))
	}
	scope := "docker-" + containerID + ".scope"
	add(filepath.Join(root, "system.slice", scope))
	add(filepath.Join(root, "docker", containerID))
	for _, controller := range v1Controllers {
		add(filepath.Join(root, controller, "system.slice", scope))
		add(filepath.Join(root, controller, "docker", containerID))
	}
	return out
}

// ValidCgroupPath accepts only a directory under root whose last element
// names the container. The daemon writes records as a less privileged user,
// so the watchdog never kills a cgroup that is not this container's.
func ValidCgroupPath(root, containerID, path string) bool {
	if path == "" || !filepath.IsAbs(path) || !ValidContainerID(containerID) {
		return false
	}
	clean := filepath.Clean(path)
	if clean != path && clean+"/" != path {
		return false
	}
	rel, err := filepath.Rel(filepath.Clean(root), clean)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return false
	}
	base := filepath.Base(clean)
	return base == containerID || base == "docker-"+containerID+".scope" || strings.HasSuffix(base, "-"+containerID+".scope")
}

// CgroupProcs returns the pids listed in path/cgroup.procs and in every
// descendant cgroup. A missing directory has no processes.
func CgroupProcs(path string) ([]int, error) {
	var pids []int
	err := filepath.WalkDir(path, func(current string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, os.ErrNotExist) {
				return nil
			}
			return walkErr
		}
		if !entry.IsDir() {
			return nil
		}
		found, readErr := readProcs(filepath.Join(current, "cgroup.procs"))
		if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
			return readErr
		}
		pids = append(pids, found...)
		return nil
	})
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return pids, err
}

func readProcs(path string) ([]int, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var pids []int
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		pid, parseErr := strconv.Atoi(strings.TrimSpace(scanner.Text()))
		if parseErr == nil && pid > 0 {
			pids = append(pids, pid)
		}
	}
	return pids, scanner.Err()
}

// ContainerCgroupEmpty reports whether no candidate cgroup of the container
// holds a process. It is the "cgroup confirmed empty" check of A6 and A12.3.
func ContainerCgroupEmpty(root, containerID, hint string) (bool, error) {
	for _, path := range CgroupCandidates(root, containerID, hint) {
		pids, err := CgroupProcs(path)
		if err != nil {
			return false, err
		}
		if len(pids) > 0 {
			return false, nil
		}
	}
	return true, nil
}

// CgroupFromProc parses /proc/<pid>/cgroup content into a directory under
// root: the unified (v2) entry, else the pids or memory v1 hierarchy.
func CgroupFromProc(root, content string) string {
	if root == "" {
		root = DefaultCgroupRoot
	}
	var v1 string
	for _, line := range strings.Split(content, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), ":", 3)
		if len(parts) != 3 || parts[2] == "" {
			continue
		}
		if parts[0] == "0" && parts[1] == "" {
			return filepath.Join(root, parts[2])
		}
		for _, controller := range strings.Split(parts[1], ",") {
			if (controller == "pids" || controller == "memory") && v1 == "" {
				v1 = filepath.Join(root, controller, parts[2])
			}
		}
	}
	return v1
}
