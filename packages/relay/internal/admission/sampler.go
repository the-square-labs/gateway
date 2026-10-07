package admission

import (
	"math"
	"os"
	"runtime"
	"runtime/metrics"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// cpuCountRefresh is how long the CPU affinity count is reused: it changes
// only when the container's cpuset does.
const cpuCountRefresh = time.Minute

// systemSampler measures the relay process. Only the controller's sampling
// loop calls it (and the first decision, once), never a tunnel admission.
type systemSampler struct {
	// probeMu guards the CPU baseline; probes overlap only at start-up.
	probeMu   sync.Mutex
	lastCPUAt time.Time
	lastCPUNs uint64
	cpuCount  int
	cpuAt     time.Time
	// measure replaces the probe in tests.
	measure func(now time.Time) ResourcePressure
}

func (s *systemSampler) Sample() ResourcePressure {
	return s.probe(time.Now())
}

func (s *systemSampler) probe(now time.Time) ResourcePressure {
	if s.measure != nil {
		return s.measure(now)
	}
	s.probeMu.Lock()
	defer s.probeMu.Unlock()
	sample := ResourcePressure{CPUPercent: s.cpuPressure(now)}
	sample.MemoryPercent, sample.MemoryRSSBytes, sample.HeapInUseBytes, sample.MemoryLimitBytes = memoryPressure()
	sample.FDPercent, sample.OpenFileDescriptors, sample.FileDescriptorLimit = fdPressure()
	return sample
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
	if s.cpuCount == 0 || now.Sub(s.cpuAt) >= cpuCountRefresh {
		s.cpuCount, s.cpuAt = effectiveCPUCount(), now
	}
	ratio := float64(used) / float64(elapsed.Nanoseconds()) / float64(s.cpuCount)
	return percent(ratio)
}

// processCPUNanoseconds is the CPU time of the whole process, threads that
// already exited included (one getrusage call instead of a file per thread).
func processCPUNanoseconds() (uint64, bool) {
	var usage syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
		return 0, false
	}
	total := usage.Utime.Nano() + usage.Stime.Nano()
	if total < 0 {
		return 0, false
	}
	return uint64(total), true
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

var heapMetrics = []string{"/memory/classes/heap/objects:bytes", "/memory/classes/heap/unused:bytes"}

// heapInUse is runtime.MemStats.HeapInuse (objects plus unused heap spans)
// read without stopping the world.
func heapInUse() uint64 {
	samples := make([]metrics.Sample, len(heapMetrics))
	for index, name := range heapMetrics {
		samples[index].Name = name
	}
	metrics.Read(samples)
	var total uint64
	for _, sample := range samples {
		if sample.Value.Kind() == metrics.KindUint64 {
			total += sample.Value.Uint64()
		}
	}
	return total
}

func memoryPressure() (uint32, uint64, uint64, uint64) {
	rss := processRSSBytes()
	maximumRaw, maximumErr := os.ReadFile("/sys/fs/cgroup/memory.max")
	if maximumErr != nil {
		maximumRaw = nil
	}
	return memoryPressureForLimit(rss, heapInUse(), maximumRaw)
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

// CgroupMemoryLimit is the finite memory.max of the relay's cgroup, or 0.
func CgroupMemoryLimit() uint64 {
	raw, err := os.ReadFile("/sys/fs/cgroup/memory.max")
	if err != nil {
		return 0
	}
	maximum, err := strconv.ParseUint(strings.TrimSpace(string(raw)), 10, 64)
	if err != nil {
		return 0
	}
	return maximum
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

// fdPressure counts open descriptors by name only: no sort and no per-entry
// stat, which matter with tens of thousands of tunnels.
func fdPressure() (uint32, uint64, uint64) {
	directory, err := os.Open("/proc/self/fd")
	if err != nil {
		return 0, 0, 0
	}
	var open uint64
	for {
		names, readErr := directory.Readdirnames(4096)
		open += uint64(len(names))
		if readErr != nil {
			break
		}
	}
	_ = directory.Close()
	// The directory handle itself is one of the entries.
	if open > 0 {
		open--
	}
	var limit syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &limit); err != nil || limit.Cur == 0 {
		return 0, open, 0
	}
	return percent(float64(open) / float64(limit.Cur)), open, limit.Cur
}

func percent(ratio float64) uint32 {
	return uint32(math.Round(math.Max(0, math.Min(1, ratio)) * 100))
}
