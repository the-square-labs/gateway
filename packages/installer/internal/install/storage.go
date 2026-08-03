package install

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"

	"charm.land/huh/v2"
)

type storageCandidate struct {
	root, mount string
	available   uint64
}

func SelectDatabaseStorageRoot() (string, error) {
	candidates, err := discoverStorageCandidates()
	if err != nil {
		return "", err
	}
	options := make([]huh.Option[string], 0, len(candidates)+1)
	for _, candidate := range candidates {
		label := fmt.Sprintf("%s (%s free)", candidate.root, humanBytes(candidate.available))
		options = append(options, huh.NewOption(label, candidate.root))
	}
	options = append(options, huh.NewOption("Custom path", "__custom__"))
	var selected string
	if err := huh.NewForm(huh.NewGroup(huh.NewSelect[string]().Title("Where should managed database disk images be stored?").Options(options...).Value(&selected))).Run(); err != nil {
		return "", err
	}
	if selected != "__custom__" {
		return selected, nil
	}
	var custom string
	if err := huh.NewForm(huh.NewGroup(huh.NewInput().Title("Managed database storage root").Description("Database .img files and mounts will be created here.").Value(&custom))).Run(); err != nil {
		return "", err
	}
	return custom, nil
}

func discoverStorageCandidates() ([]storageCandidate, error) {
	file, err := os.Open("/proc/mounts")
	if err != nil {
		return []storageCandidate{{root: "/var/lib/docker-daemon/databases"}}, nil
	}
	defer file.Close()
	seen := map[string]bool{}
	var candidates []storageCandidate
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 3 {
			continue
		}
		mount, fsType := fields[1], fields[2]
		if mount == "/" || seen[mount] || isVirtualFilesystem(fsType) {
			continue
		}
		seen[mount] = true
		var stat syscall.Statfs_t
		if err := syscall.Statfs(mount, &stat); err != nil || stat.Bavail == 0 {
			continue
		}
		root := filepath.Join(mount, "gateway-databases")
		candidates = append(candidates, storageCandidate{root: root, mount: mount, available: stat.Bavail * uint64(stat.Bsize)})
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].available > candidates[j].available })
	if len(candidates) == 0 {
		candidates = append(candidates, storageCandidate{root: "/var/lib/docker-daemon/databases"})
	}
	return candidates, nil
}

func isVirtualFilesystem(fsType string) bool {
	switch fsType {
	case "proc", "sysfs", "tmpfs", "devtmpfs", "devpts", "cgroup", "cgroup2", "overlay", "squashfs", "nsfs":
		return true
	default:
		return false
	}
}

func humanBytes(value uint64) string {
	units := []string{"B", "KiB", "MiB", "GiB", "TiB"}
	number := float64(value)
	i := 0
	for number >= 1024 && i < len(units)-1 {
		number /= 1024
		i++
	}
	return fmt.Sprintf("%.1f %s", number, units[i])
}
