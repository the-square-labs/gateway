package admission

import (
	"math"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

const (
	TrafficClassProxy    = "proxy"
	TrafficClassDatabase = "database"

	defaultProxyTargetPercent  = 70
	defaultDatabaseReserve     = 20
	defaultHardPressurePercent = 95
	pressureSampleInterval     = 250 * time.Millisecond
)

type ResourcePressure struct {
	CPUPercent          uint32
	MemoryPercent       uint32
	FDPercent           uint32
	MemoryRSSBytes      uint64
	HeapInUseBytes      uint64
	MemoryLimitBytes    uint64
	OpenFileDescriptors uint64
	FileDescriptorLimit uint64
}

func (p ResourcePressure) Maximum() uint32 {
	return max(p.CPUPercent, p.MemoryPercent, p.FDPercent)
}

type Usage struct {
	ActiveProxy    uint64
	ActiveDatabase uint64
	ProxyByRoute   map[string]uint64
}

type Snapshot struct {
	State                  string
	PressurePercent        uint32
	CPUPressurePercent     uint32
	MemoryPressurePercent  uint32
	FDPressurePercent      uint32
	MemoryRSSBytes         uint64
	HeapInUseBytes         uint64
	MemoryLimitBytes       uint64
	OpenFileDescriptors    uint64
	FileDescriptorLimit    uint64
	ThrottledProxyTotal    uint64
	ThrottledDatabaseTotal uint64
}

type sampler interface {
	Sample() ResourcePressure
}

type Controller struct {
	mu                     sync.Mutex
	policy                 *relayv1.AdmissionPolicy
	sampler                sampler
	state                  string
	ewmaPressure           float64
	ewmaCPU                float64
	ewmaMemory             float64
	ewmaFD                 float64
	ewmaInitialized        bool
	last                   ResourcePressure
	throttledProxyTotal    uint64
	throttledDatabaseTotal uint64
}

func New() *Controller {
	return NewWithSampler(&systemSampler{})
}

func NewWithSampler(source sampler) *Controller {
	controller := &Controller{sampler: source, state: "normal"}
	controller.UpdatePolicy(nil)
	return controller
}

func (c *Controller) UpdatePolicy(next *relayv1.AdmissionPolicy) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.policy = normalizedPolicy(next)
	if !c.policy.Enabled {
		c.state = "disabled"
	} else if c.state == "disabled" {
		c.state = "normal"
	}
}

func (c *Controller) Admit(trafficClass, routeID string, usage Usage) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.refreshLocked()
	if !c.policy.Enabled {
		return nil
	}

	pressure := uint32(math.Round(c.ewmaPressure))
	proxyTarget := c.policy.ProxyTargetPressurePercent
	hardCutoff := c.policy.HardPressurePercent
	proxyCutoff := hardCutoff - c.policy.DatabaseReservePercent

	if trafficClass == TrafficClassDatabase {
		if pressure >= hardCutoff {
			c.throttledDatabaseTotal++
			return &Rejected{TrafficClass: trafficClass, State: "hard_pressure"}
		}
		return nil
	}

	if pressure >= proxyCutoff {
		c.throttledProxyTotal++
		return &Rejected{TrafficClass: TrafficClassProxy, State: "database_reserve"}
	}
	if pressure < proxyTarget || c.state == "normal" {
		return nil
	}
	if routeGetsFairAdmission(routeID, usage) {
		return nil
	}
	c.throttledProxyTotal++
	return &Rejected{TrafficClass: TrafficClassProxy, State: "fair_share"}
}

func (c *Controller) GetSnapshot() Snapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.refreshLocked()
	return Snapshot{
		State:                  c.state,
		PressurePercent:        uint32(math.Round(c.ewmaPressure)),
		CPUPressurePercent:     uint32(math.Round(c.ewmaCPU)),
		MemoryPressurePercent:  uint32(math.Round(c.ewmaMemory)),
		FDPressurePercent:      uint32(math.Round(c.ewmaFD)),
		MemoryRSSBytes:         c.last.MemoryRSSBytes,
		HeapInUseBytes:         c.last.HeapInUseBytes,
		MemoryLimitBytes:       c.last.MemoryLimitBytes,
		OpenFileDescriptors:    c.last.OpenFileDescriptors,
		FileDescriptorLimit:    c.last.FileDescriptorLimit,
		ThrottledProxyTotal:    c.throttledProxyTotal,
		ThrottledDatabaseTotal: c.throttledDatabaseTotal,
	}
}

func (c *Controller) refreshLocked() {
	c.last = c.sampler.Sample()
	instant := float64(c.last.Maximum())
	if !c.ewmaInitialized {
		c.ewmaPressure = instant
		c.ewmaCPU = float64(c.last.CPUPercent)
		c.ewmaMemory = float64(c.last.MemoryPercent)
		c.ewmaFD = float64(c.last.FDPercent)
		c.ewmaInitialized = true
	} else {
		c.ewmaPressure = c.ewmaPressure*0.75 + instant*0.25
		c.ewmaCPU = c.ewmaCPU*0.75 + float64(c.last.CPUPercent)*0.25
		c.ewmaMemory = c.ewmaMemory*0.75 + float64(c.last.MemoryPercent)*0.25
		c.ewmaFD = c.ewmaFD*0.75 + float64(c.last.FDPercent)*0.25
	}
	if !c.policy.Enabled {
		c.state = "disabled"
		return
	}
	pressure := uint32(math.Round(c.ewmaPressure))
	proxyTarget := c.policy.ProxyTargetPressurePercent
	proxyCutoff := c.policy.HardPressurePercent - c.policy.DatabaseReservePercent
	recovery := proxyTarget - 10
	switch {
	case pressure >= c.policy.HardPressurePercent:
		c.state = "hard_pressure"
	case pressure >= proxyCutoff:
		c.state = "database_reserved"
	case pressure >= proxyTarget:
		c.state = "proxy_throttled"
	case pressure <= recovery:
		c.state = "normal"
	}
}

func normalizedPolicy(value *relayv1.AdmissionPolicy) *relayv1.AdmissionPolicy {
	if value == nil {
		return &relayv1.AdmissionPolicy{
			Enabled:                    true,
			ProxyTargetPressurePercent: defaultProxyTargetPercent,
			DatabaseReservePercent:     defaultDatabaseReserve,
			HardPressurePercent:        defaultHardPressurePercent,
		}
	}
	return &relayv1.AdmissionPolicy{
		Enabled:                    value.Enabled,
		ProxyTargetPressurePercent: value.ProxyTargetPressurePercent,
		DatabaseReservePercent:     value.DatabaseReservePercent,
		HardPressurePercent:        value.HardPressurePercent,
	}
}

func routeGetsFairAdmission(routeID string, usage Usage) bool {
	current := usage.ProxyByRoute[routeID]
	if current == 0 {
		return true
	}
	activeRoutes := uint64(0)
	for _, count := range usage.ProxyByRoute {
		if count > 0 {
			activeRoutes++
		}
	}
	if activeRoutes <= 1 {
		return false
	}
	fairShare := (usage.ActiveProxy + activeRoutes - 1) / activeRoutes
	return current < fairShare
}

type Rejected struct {
	TrafficClass string
	State        string
}

func (e *Rejected) Error() string {
	return "relay adaptive admission rejected " + e.TrafficClass + " tunnel: " + e.State
}

type systemSampler struct {
	mu        sync.Mutex
	cachedAt  time.Time
	cached    ResourcePressure
	lastCPUAt time.Time
	lastCPUNs uint64
}

func (s *systemSampler) Sample() ResourcePressure {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if !s.cachedAt.IsZero() && now.Sub(s.cachedAt) < pressureSampleInterval {
		return s.cached
	}
	s.cached = ResourcePressure{
		CPUPercent: s.cpuPressure(now),
	}
	s.cached.MemoryPercent, s.cached.MemoryRSSBytes, s.cached.HeapInUseBytes, s.cached.MemoryLimitBytes = memoryPressure()
	s.cached.FDPercent, s.cached.OpenFileDescriptors, s.cached.FileDescriptorLimit = fdPressure()
	s.cachedAt = now
	return s.cached
}

func (s *systemSampler) cpuPressure(now time.Time) uint32 {
	current, ok := processCPUNanoseconds()
	if !ok {
		return 0
	}
	if s.lastCPUAt.IsZero() || current < s.lastCPUNs {
		s.lastCPUAt, s.lastCPUNs = now, current
		return 0
	}
	elapsed := now.Sub(s.lastCPUAt)
	used := current - s.lastCPUNs
	s.lastCPUAt, s.lastCPUNs = now, current
	if elapsed <= 0 {
		return 0
	}
	ratio := float64(used) / float64(elapsed.Nanoseconds()) / float64(effectiveCPUCount())
	return percent(ratio)
}

func processCPUNanoseconds() (uint64, bool) {
	threads, err := os.ReadDir("/proc/self/task")
	if err != nil {
		return 0, false
	}
	var total uint64
	var sampled bool
	for _, thread := range threads {
		used, ok := readFirstUint("/proc/self/task/" + thread.Name() + "/schedstat")
		if !ok {
			continue
		}
		total += used
		sampled = true
	}
	return total, sampled
}

func effectiveCPUCount() int {
	data, err := os.ReadFile("/proc/self/status")
	if err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "Cpus_allowed_list:") {
				if count := countCPUList(strings.TrimSpace(strings.TrimPrefix(line, "Cpus_allowed_list:"))); count > 0 {
					return count
				}
			}
		}
	}
	return max(1, runtime.GOMAXPROCS(0))
}

func countCPUList(value string) int {
	count := 0
	for _, group := range strings.Split(value, ",") {
		bounds := strings.SplitN(strings.TrimSpace(group), "-", 2)
		first, err := strconv.Atoi(bounds[0])
		if err != nil {
			return 0
		}
		last := first
		if len(bounds) == 2 {
			last, err = strconv.Atoi(bounds[1])
			if err != nil || last < first {
				return 0
			}
		}
		count += last - first + 1
	}
	return count
}

func memoryPressure() (uint32, uint64, uint64, uint64) {
	rss := processRSSBytes()
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	maximumRaw, maximumErr := os.ReadFile("/sys/fs/cgroup/memory.max")
	if maximumErr != nil {
		maximumRaw = nil
	}
	return memoryPressureForLimit(rss, stats.HeapInuse, maximumRaw)
}

func memoryPressureForLimit(rss, heap uint64, maximumRaw []byte) (uint32, uint64, uint64, uint64) {
	maximum, err := strconv.ParseUint(strings.TrimSpace(string(maximumRaw)), 10, 64)
	if err == nil && maximum > 0 {
		return percent(float64(rss) / float64(maximum)), rss, heap, maximum
	}
	// A container without a finite cgroup limit has no meaningful memory
	// denominator. In particular, /proc/meminfo can describe the outer LXC or
	// physical host. Report the relay's real RSS/heap, but do not turn unrelated
	// host memory usage into relay admission pressure.
	return 0, rss, heap, 0
}

func processRSSBytes() uint64 {
	data, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(data))
	if len(fields) < 2 {
		return 0
	}
	residentPages, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0
	}
	return residentPages * uint64(os.Getpagesize())
}

func fdPressure() (uint32, uint64, uint64) {
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		return 0, 0, 0
	}
	var limit syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &limit); err != nil || limit.Cur == 0 {
		return 0, uint64(len(entries)), 0
	}
	return percent(float64(len(entries)) / float64(limit.Cur)), uint64(len(entries)), limit.Cur
}

func readFirstUint(path string) (uint64, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return 0, false
	}
	value, err := strconv.ParseUint(fields[0], 10, 64)
	return value, err == nil
}

func percent(ratio float64) uint32 {
	return uint32(math.Round(math.Max(0, math.Min(1, ratio)) * 100))
}
