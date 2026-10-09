package handover

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/atomicfile"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/relayresume"
)

// Every update reports what it did to the connections the daemon carried (the
// measure for the stand and the field): the stopping process records what it
// handed over and what it cut, the next one adds what resumed, and reports the
// result to Gateway in its health reports until the next update.

const (
	// pendingReportFile is written by the stopping process for the next one.
	pendingReportFile = "update-connections.json"
	// lastReportFile is the final report of the last update.
	lastReportFile = "update-connections-last.json"
	// settleLimit bounds the wait for the handed over streams: a source has
	// UnplannedBudget to find a path, a target TargetSuspendTimeout.
	settleLimit = relayresume.TargetSuspendTimeout + 5*time.Second
)

// settleProof is how long the counts wait after the last stream resumed, and
// settleTick how often they look (variables for tests).
var (
	settleProof = time.Second
	settleTick  = 250 * time.Millisecond
)

// Report is what one update did to the daemon's connections.
type Report struct {
	FromVersion string         `json:"fromVersion"`
	ToVersion   string         `json:"toVersion,omitempty"`
	StartedAt   time.Time      `json:"startedAt"`
	FinishedAt  time.Time      `json:"finishedAt,omitzero"`
	Handover    bool           `json:"handover"`
	HandedOver  int            `json:"handedOver"`
	Kept        int            `json:"kept"`
	Cut         map[string]int `json:"cut,omitempty"`
	PauseP50    time.Duration  `json:"pauseP50,omitempty"`
	PauseP99    time.Duration  `json:"pauseP99,omitempty"`
	PauseMax    time.Duration  `json:"pauseMax,omitempty"`
}

// AddCut counts n connections cut under class.
func (r *Report) AddCut(class string, n int) {
	if n <= 0 || class == "" {
		return
	}
	if r.Cut == nil {
		r.Cut = map[string]int{}
	}
	r.Cut[class] += n
}

// WritePending records what the stopping process did, for the next one.
func WritePending(stateDir string, report Report) error {
	return writeReport(filepath.Join(stateDir, pendingReportFile), report)
}

func writeReport(path string, report Report) error {
	data, err := json.Marshal(report)
	if err != nil {
		return err
	}
	return atomicfile.WriteFile(path, data, 0o600)
}

func readReport(path string) (*Report, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var report Report
	if err := json.Unmarshal(data, &report); err != nil {
		return nil, err
	}
	return &report, nil
}

// Tracker settles, in the next process, the update the previous one reported:
// it waits until every stream taken over resumed or ended, then keeps the
// final report.
type Tracker struct {
	stateDir string

	mu       sync.Mutex
	pending  *Report
	sessions []*relayresume.Session
	// lost are the sessions whose local connection ended before they
	// resumed, or failed before the counts were final (CutLocalClosed).
	lost    map[*relayresume.Session]bool
	tracked map[*relayresume.Session]bool
	kept    int
	cut     map[string]int
	// later are the cuts CutAfter added before the counts were final.
	later   map[string]int
	last    *Report
	settled chan struct{}
}

// NewTracker starts a tracker for a process of version: it takes the report
// the previous process left (none for a fresh start or an older binary) and
// the final report of the last update.
func NewTracker(stateDir, version string) *Tracker {
	t := &Tracker{stateDir: stateDir, cut: map[string]int{}, settled: make(chan struct{})}
	if last, err := readReport(filepath.Join(stateDir, lastReportFile)); err == nil {
		t.last = last
	}
	path := filepath.Join(stateDir, pendingReportFile)
	pending, err := readReport(path)
	if err == nil || !errors.Is(err, os.ErrNotExist) {
		_ = os.Remove(path)
	}
	if err == nil && time.Since(pending.StartedAt) < 30*time.Minute {
		pending.ToVersion = version
		t.pending = pending
	} else {
		close(t.settled)
	}
	return t
}

// Track follows a stream taken over until it resumed or ended.
func (t *Tracker) Track(session *relayresume.Session) {
	t.mu.Lock()
	t.sessions = append(t.sessions, session)
	if t.tracked == nil {
		t.tracked = map[*relayresume.Session]bool{}
	}
	t.tracked[session] = true
	t.mu.Unlock()
}

// localEnded hears that the local connection of a bridged session ended (err
// nil: its end of stream). For a stream taken over whose counts are not final
// yet, an end before the stream resumed (the local peer gave up, or something
// closed it, during the pause) or a failure at any time means the update did
// not keep the connection: a stream that resumed carries nothing to a local
// connection that is gone (stand rc.7 F-1, a truncated download reported
// kept).
func (t *Tracker) localEnded(session *relayresume.Session, err error) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.pending == nil || !t.tracked[session] {
		return
	}
	if _, resumed, _ := session.HandoverPause(); resumed && err == nil {
		return
	}
	if t.lost == nil {
		t.lost = map[*relayresume.Session]bool{}
	}
	t.lost[session] = true
}

// Kept counts n connections taken over that carry on without a stream to
// resume (pipes).
func (t *Tracker) Kept(n int) {
	t.mu.Lock()
	t.kept += n
	t.mu.Unlock()
}

// Cut counts n connections taken over that this process ended.
func (t *Tracker) Cut(class string, n int) {
	if n <= 0 {
		return
	}
	t.mu.Lock()
	t.cut[class] += n
	t.mu.Unlock()
}

// CutAfter counts n connections of class that a consequence of an update cut
// after the update itself (a replaced connector removed at its retirement
// limit): they join the last update's report, which becomes a new final
// report (FinishedAt now) for Gateway to take again. It reports false when
// there is no report to join: the daemon has not been updated since it
// reports them.
func (t *Tracker) CutAfter(class string, n int) bool {
	if t == nil || n <= 0 || class == "" {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.pending != nil {
		if t.later == nil {
			t.later = map[string]int{}
		}
		t.later[class] += n
		return true
	}
	if t.last == nil {
		return false
	}
	report := *t.last
	report.Cut = map[string]int{}
	for existing, count := range t.last.Cut {
		report.Cut[existing] = count
	}
	report.AddCut(class, n)
	report.FinishedAt = time.Now()
	t.last = &report
	_ = writeReport(filepath.Join(t.stateDir, lastReportFile), report)
	return true
}

// Settle waits until every stream taken over resumed or ended (at most
// settleLimit), then keeps the final report. Run it once, after the
// restore.
func (t *Tracker) Settle() {
	t.mu.Lock()
	pending := t.pending
	t.mu.Unlock()
	if pending == nil {
		return
	}
	deadline := time.Now().Add(settleLimit)
	var settledAt time.Time
	for {
		t.mu.Lock()
		sessions := slices.Clone(t.sessions)
		t.mu.Unlock()
		open := 0
		failed := 0
		for _, session := range sessions {
			_, resumed, ended := session.HandoverPause()
			switch {
			case resumed:
			case ended:
				failed++
			default:
				open++
			}
		}
		now := time.Now()
		if open > 0 {
			settledAt = time.Time{}
		} else if settledAt.IsZero() {
			// A local connection that is gone shows when the resumed stream
			// first writes to it: the counts become final a moment later.
			settledAt = now
		}
		if (open == 0 && (len(sessions) == 0 || now.Sub(settledAt) >= settleProof)) || now.After(deadline) {
			t.finish(pending, sessions, failed+open)
			return
		}
		time.Sleep(settleTick)
	}
}

func (t *Tracker) finish(pending *Report, sessions []*relayresume.Session, failed int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	var pauses []time.Duration
	lost := 0
	for _, session := range sessions {
		pause, resumed, _ := session.HandoverPause()
		switch {
		case t.lost[session]:
			lost++
			if !resumed {
				// Counted as not resumed already.
				failed--
			}
		case resumed:
			pauses = append(pauses, pause)
		}
	}
	report := *pending
	report.Cut = map[string]int{}
	for class, n := range pending.Cut {
		report.Cut[class] = n
	}
	report.Kept = t.kept + len(pauses)
	for class, n := range t.cut {
		report.AddCut(class, n)
	}
	report.AddCut(CutResumeFailed, failed)
	report.AddCut(CutLocalClosed, lost)
	// What the previous process handed over and this one never saw (a
	// snapshot that did not come over) is cut too.
	accounted := report.Kept + failed + lost
	for _, n := range t.cut {
		accounted += n
	}
	report.AddCut(CutResumeFailed, report.HandedOver-accounted)
	for class, n := range t.later {
		report.AddCut(class, n)
	}
	if len(pauses) > 0 {
		slices.Sort(pauses)
		report.PauseP50 = pauses[len(pauses)/2]
		report.PauseP99 = pauses[min(len(pauses)-1, len(pauses)*99/100)]
		report.PauseMax = pauses[len(pauses)-1]
	}
	report.FinishedAt = time.Now()
	t.last = &report
	t.pending = nil
	_ = writeReport(filepath.Join(t.stateDir, lastReportFile), report)
	close(t.settled)
}

// Last is the final report of the last update (nil: none yet).
func (t *Tracker) Last() *Report {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.last
}

// Proto is the report for Gateway.
func (r *Report) Proto() *pb.DaemonUpdateConnectionReport {
	if r == nil {
		return nil
	}
	report := &pb.DaemonUpdateConnectionReport{
		FromVersion: r.FromVersion, ToVersion: r.ToVersion, StartedAtUnixMs: r.StartedAt.UnixMilli(), Handover: r.Handover,
		HandedOver: uint32(max(r.HandedOver, 0)), Kept: uint32(max(r.Kept, 0)), Cut: cutProto(r.Cut),
		PauseP50Ms: uint32(r.PauseP50.Milliseconds()), PauseP99Ms: uint32(r.PauseP99.Milliseconds()), PauseMaxMs: uint32(r.PauseMax.Milliseconds()),
	}
	if !r.FinishedAt.IsZero() {
		report.FinishedAtUnixMs = r.FinishedAt.UnixMilli()
	}
	return report
}

// Status is the health report's view: what an update now would keep and cut,
// and the last update.
func Status(available bool, kept int, cut map[string]int, last *Report) *pb.DaemonUpdateConnections {
	return &pb.DaemonUpdateConnections{HandoverAvailable: available, Kept: uint32(max(kept, 0)), Cut: cutProto(cut), LastUpdate: last.Proto()}
}

func cutProto(cut map[string]int) map[string]uint32 {
	if len(cut) == 0 {
		return nil
	}
	result := make(map[string]uint32, len(cut))
	for class, n := range cut {
		if n > 0 {
			result[class] = uint32(n)
		}
	}
	return result
}
