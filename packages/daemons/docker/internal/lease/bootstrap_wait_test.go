package lease

import (
	"bytes"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

type lockedLog struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *lockedLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *lockedLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

// Stand run rc20pre4 B-23: the named bootstrap holder did not find its copy
// (recreated under a new ID) and waited silently for hours. It now says why,
// once, and acquires as soon as its copy is there.
func TestBootstrapHolderWithoutItsCopySaysWhyAndAcquiresOnceItIsThere(t *testing.T) {
	w := newWorld(t, worldSpec{relays: []string{"r1", "r2", "r3"}, daemons: []string{"d1", "d2"}, candidates: []string{"d1", "d2"}, bootstrap: "d2"})
	logs := &lockedLog{}
	w.logger = slog.New(slog.NewTextHandler(logs, nil))
	w.daemon("d1").addContainer(testPolicy, false)
	w.restartDaemon("d2")
	w.run(20 * time.Second)

	const reason = "no copy of the workload was found on this node"
	if got := strings.Count(logs.String(), reason); got != 1 {
		t.Fatalf("the waiting bootstrap holder logs its reason once, got %d times\n%s", got, logs.String())
	}
	if holder := w.holderOf(); holder != "" {
		t.Fatalf("the reserved slot stays unheld while its holder has no copy, holder %s\n%s", holder, w.dump())
	}

	w.daemon("d2").addContainer(testPolicy, true)
	w.waitServing("d2", 45*time.Second)
	w.run(5 * time.Second)
	w.requireClean()
}
