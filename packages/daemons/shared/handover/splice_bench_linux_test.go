//go:build linux

package handover

import (
	"io"
	"net"
	"os"
	"syscall"
	"testing"
	"time"
)

// BenchmarkPipeCost measures one direction of a node-local pipe per socket
// pair and method: CPU of the whole process (generator and sink included,
// the same for every method) per GiB, and throughput. Run on Linux:
//
//	go test -run x -bench PipeCost -benchtime 6x ./handover
//
// "splice-8k" is the rc.10 splicer once the user's pipe budget is spent
// (stand rc.10 F-2); "buffer" is the copy through the 32/256 KiB buffers;
// "io.Copy" what rc.8 ran.
func BenchmarkPipeCost(b *testing.B) {
	const size = 256 << 20
	pairs := []struct {
		name                string
		leftUnix, rightUnix bool
	}{{"tcp-tcp", false, false}, {"unix-tcp", true, false}, {"tcp-unix", false, true}, {"unix-unix", true, true}}
	for _, pair := range pairs {
		for _, method := range []string{"splice", "splice-8k", "buffer", "io.Copy"} {
			b.Run(pair.name+"/"+method, func(b *testing.B) {
				b.SetBytes(size)
				restore := benchMethod(method)
				defer restore()
				measurePipe(b, size, func() {
					client, left := benchPair(b, pair.leftUnix)
					right, server := benchPair(b, pair.rightUnix)
					done := make(chan struct{})
					go func() {
						defer close(done)
						if method == "io.Copy" {
							_, _ = io.Copy(right, left)
							_ = right.(interface{ CloseWrite() error }).CloseWrite()
							return
						}
						_ = (*Registry)(nil).Pipe(left, right, PipeConfig{})
					}()
					go func() {
						chunk := make([]byte, 256<<10)
						for sent := 0; sent < size; sent += len(chunk) {
							if _, err := client.Write(chunk); err != nil {
								return
							}
						}
						_ = client.(interface{ CloseWrite() error }).CloseWrite()
					}()
					sink := make([]byte, 256<<10)
					got := 0
					for {
						n, err := server.Read(sink)
						got += n
						if err != nil {
							break
						}
					}
					if got != size {
						b.Fatalf("moved %d", got)
					}
					_ = server.Close()
					_ = client.Close()
					if method == "io.Copy" {
						_ = left.Close()
						_ = right.Close()
					}
					<-done
				})
			})
		}
	}
}

func benchMethod(method string) func() {
	worth, bytes, min := spliceWorth, splicePipeBytes, splicePipeMin
	switch method {
	case "buffer":
		spliceWorth = func(bool, bool) bool { return false }
	case "splice-8k":
		splicePipeBytes, splicePipeMin = 8192, 0
	case "splice":
		spliceWorth = func(bool, bool) bool { return true }
	}
	drainPipes()
	return func() {
		spliceWorth, splicePipeBytes, splicePipeMin = worth, bytes, min
		drainPipes()
	}
}

func drainPipes() {
	splicePipes.Lock()
	for _, pipe := range splicePipes.free {
		pipe.close()
	}
	splicePipes.open -= len(splicePipes.free)
	splicePipes.free, splicePipes.refused = nil, time.Time{}
	splicePipes.Unlock()
}

func benchPair(b testing.TB, unixSocket bool) (net.Conn, net.Conn) {
	if unixSocket {
		fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
		if err != nil {
			b.Fatal(err)
		}
		conns := [2]net.Conn{}
		for i, fd := range fds {
			file := os.NewFile(uintptr(fd), "pair")
			conn, err := net.FileConn(file)
			_ = file.Close()
			if err != nil {
				b.Fatal(err)
			}
			conns[i] = conn
		}
		return conns[0], conns[1]
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		b.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() { c, _ := listener.Accept(); accepted <- c }()
	dialed, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		b.Fatal(err)
	}
	return dialed, <-accepted
}

func measurePipe(b *testing.B, size int, transfer func()) {
	var before, after syscall.Rusage
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &before)
	b.ResetTimer()
	for range b.N {
		transfer()
	}
	b.StopTimer()
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &after)
	user := time.Duration(syscall.TimevalToNsec(after.Utime) - syscall.TimevalToNsec(before.Utime))
	system := time.Duration(syscall.TimevalToNsec(after.Stime) - syscall.TimevalToNsec(before.Stime))
	gib := float64(b.N) * float64(size) / float64(1<<30)
	b.ReportMetric((user+system).Seconds()/gib, "cpu-s/GiB")
	b.ReportMetric(system.Seconds()/gib, "sys-s/GiB")
}
