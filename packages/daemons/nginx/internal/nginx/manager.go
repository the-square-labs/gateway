package nginx

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type Manager struct {
	binary    string
	configDir string
	certsDir  string
	globalCfg string
}

func NewManager(binary, configDir, certsDir, globalConfig string) *Manager {
	return &Manager{
		binary:    binary,
		configDir: configDir,
		certsDir:  certsDir,
		globalCfg: globalConfig,
	}
}

func (m *Manager) TestConfig() (bool, string) {
	args := []string{"-t"}
	if m.globalCfg != "" {
		args = append(args, "-c", m.globalCfg)
	}
	cmd := exec.Command(m.binary, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return false, string(output)
	}
	return true, string(output)
}

func (m *Manager) Reload() error {
	args := []string{"-s", "reload"}
	if m.globalCfg != "" {
		args = append(args, "-c", m.globalCfg)
	}
	cmd := exec.Command(m.binary, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("nginx reload failed: %s: %w", string(output), err)
	}
	return nil
}

func (m *Manager) GetVersion() (string, error) {
	cmd := exec.Command(m.binary, "-v")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("nginx version check failed: %w", err)
	}
	// nginx -v outputs to stderr: "nginx version: nginx/1.27.0"
	s := strings.TrimSpace(string(output))
	if idx := strings.Index(s, "nginx/"); idx >= 0 {
		return s[idx+len("nginx/"):], nil
	}
	return s, nil
}

// HasSecureLinkModule verifies that this nginx build did not explicitly omit
// the built-in secure-link module required by Gateway maintenance admission.
func (m *Manager) HasSecureLinkModule() (bool, error) {
	cmd := exec.Command(m.binary, "-V")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("nginx build check failed: %w", err)
	}
	return !strings.Contains(string(output), "--without-http_secure_link_module"), nil
}

func (m *Manager) IsRunning() bool {
	pidFile := m.findPidFile()
	if pidFile != "" {
		data, err := os.ReadFile(pidFile)
		if err == nil {
			pid, parseErr := strconv.Atoi(strings.TrimSpace(string(data)))
			if parseErr == nil {
				proc, findErr := os.FindProcess(pid)
				if findErr == nil {
					// On Unix, FindProcess always succeeds. Check if process exists via signal 0.
					if signalErr := proc.Signal(syscall.Signal(0)); signalErr == nil {
						return true
					}
				}
			}
		}
	}

	return m.hasRunningProcess()
}

func (m *Manager) GetUptime() (time.Duration, error) {
	pidFile := m.findPidFile()
	if pidFile == "" {
		return 0, fmt.Errorf("pid file not found")
	}
	data, err := os.ReadFile(pidFile)
	if err != nil {
		return 0, fmt.Errorf("read pid file: %w", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return 0, fmt.Errorf("parse pid: %w", err)
	}
	// Read process start time from /proc
	statPath := fmt.Sprintf("/proc/%d/stat", pid)
	statData, err := os.ReadFile(statPath)
	if err != nil {
		return 0, fmt.Errorf("read proc stat: %w", err)
	}
	// Field 22 (0-indexed: 21) is starttime in clock ticks
	fields := strings.Fields(string(statData))
	if len(fields) < 22 {
		return 0, fmt.Errorf("unexpected stat format")
	}
	startTicks, err := strconv.ParseInt(fields[21], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse start time: %w", err)
	}

	// Get system uptime
	uptimeData, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0, fmt.Errorf("read uptime: %w", err)
	}
	uptimeFields := strings.Fields(string(uptimeData))
	if len(uptimeFields) < 1 {
		return 0, fmt.Errorf("unexpected uptime format")
	}
	systemUptime, err := strconv.ParseFloat(uptimeFields[0], 64)
	if err != nil {
		return 0, fmt.Errorf("parse system uptime: %w", err)
	}

	// Clock ticks per second (typically 100 on Linux)
	clkTck := int64(100)
	processStartSec := float64(startTicks) / float64(clkTck)
	processUptime := systemUptime - processStartSec

	return time.Duration(processUptime * float64(time.Second)), nil
}

func (m *Manager) GetWorkerCount() (int, error) {
	cmd := exec.Command("pgrep", "-c", "-f", "nginx: worker")
	output, err := cmd.Output()
	if err != nil {
		return 0, nil // No workers = 0
	}
	count, err := strconv.Atoi(strings.TrimSpace(string(output)))
	if err != nil {
		return 0, nil
	}
	return count, nil
}

func (m *Manager) findPidFile() string {
	candidates := []string{
		"/run/nginx.pid",
		"/var/run/nginx.pid",
		"/run/nginx/nginx.pid",
		"/var/run/nginx/nginx.pid",
		"/etc/nginx/nginx.pid",
	}
	// Also try to parse from nginx.conf
	if m.globalCfg != "" {
		data, err := os.ReadFile(m.globalCfg)
		if err == nil {
			for _, line := range strings.Split(string(data), "\n") {
				line = strings.TrimSpace(line)
				if strings.HasPrefix(line, "pid ") {
					pidPath := strings.TrimSuffix(strings.TrimPrefix(line, "pid "), ";")
					pidPath = strings.TrimSpace(pidPath)
					candidates = append([]string{pidPath}, candidates...)
					break
				}
			}
		}
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

func (m *Manager) hasRunningProcess() bool {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return false
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid := entry.Name()
		if _, err := strconv.Atoi(pid); err != nil {
			continue
		}

		cmdline, err := os.ReadFile(filepath.Join("/proc", pid, "cmdline"))
		if err == nil {
			cmdlineText := strings.ReplaceAll(string(cmdline), "\x00", " ")
			if strings.Contains(cmdlineText, "nginx: master process") {
				return true
			}
			if strings.Contains(cmdlineText, m.binary) {
				return true
			}
		}

		comm, err := os.ReadFile(filepath.Join("/proc", pid, "comm"))
		if err == nil && strings.TrimSpace(string(comm)) == "nginx" {
			return true
		}
	}

	return false
}

// GetProcessRSS scans /proc for all nginx processes and sums their RSS in bytes.
func (m *Manager) GetProcessRSS() int64 {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}

	var totalRSS int64

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		// Skip non-numeric directory names (not PIDs)
		pid := entry.Name()
		if _, err := strconv.Atoi(pid); err != nil {
			continue
		}

		// Read cmdline to check if this is an nginx process
		cmdline, err := os.ReadFile(filepath.Join("/proc", pid, "cmdline"))
		if err != nil {
			continue
		}
		// cmdline uses null bytes as separators
		if !strings.Contains(string(cmdline), "nginx") {
			continue
		}

		// Read VmRSS from /proc/<pid>/status
		statusData, err := os.ReadFile(filepath.Join("/proc", pid, "status"))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(statusData), "\n") {
			if strings.HasPrefix(line, "VmRSS:") {
				fields := strings.Fields(line)
				if len(fields) >= 2 {
					val, err := strconv.ParseInt(fields[1], 10, 64)
					if err == nil {
						// VmRSS is in kB
						totalRSS += val * 1024
					}
				}
				break
			}
		}
	}

	return totalRSS
}

func (m *Manager) ConfigPath(hostID string) string {
	return filepath.Join(m.configDir, fmt.Sprintf("proxy-host-%s.conf", hostID))
}

func (m *Manager) CertDir(certID string) string {
	return filepath.Join(m.certsDir, certID)
}
