package relayresume

import (
	"bytes"
	"testing"
)

// FuzzParseFrame: the parser never panics, accepts only frames that encode
// back to the same bytes (strict, one encoding per record) and never reads
// past the frame.
func FuzzParseFrame(f *testing.F) {
	for _, seed := range [][]byte{
		{TypeClose},
		{TypeData, 0, 'x'},
		{TypeAck, 0x80, 0x01, 0x10},
		{TypeFin, 5, TypeClose},
		{TypeRst, 1, 2, 'h', 'i'},
		{TypeMigrateReq, 1},
		append([]byte{TypeHello}, []byte("GWRS\x01\x02v1")...),
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, frame []byte) {
		records, err := ParseFrame(frame)
		if err != nil {
			return
		}
		var encoded []byte
		for i := range records {
			if records[i].Type == TypeData && i != len(records)-1 {
				t.Fatalf("DATA is not the last record")
			}
			encoded, err = AppendRecord(encoded, &records[i])
			if err != nil {
				t.Fatalf("parsed record does not encode: %v", err)
			}
		}
		if !bytes.Equal(encoded, frame) {
			t.Fatalf("frame %x re-encodes to %x", frame, encoded)
		}
	})
}

// FuzzCorePeerFrames feeds arbitrary frames to an established target and
// source: they reset or carry on, never panic, and never deliver bytes that
// break the receive offsets.
func FuzzCorePeerFrames(f *testing.F) {
	f.Add([]byte{TypeData, 0, 'a'}, []byte{TypeFin, 0})
	f.Add([]byte{TypeAck, 9, 0x80, 0x80, 0x10}, []byte{TypeClose})
	f.Add([]byte{TypeRst, 3, 0}, []byte{TypeMigrateReq, 2})
	f.Fuzz(func(t *testing.T, first, second []byte) {
		pair := newCorePair(t)
		pair.src.Write([]byte("hello"), pair.now)
		pair.flush()
		for _, frame := range [][]byte{first, second} {
			for _, side := range []*Core{pair.src, pair.tgt} {
				if len(frame) == 0 || side.State().Terminal() {
					continue
				}
				side.PathFrame(side.Current(), append([]byte(nil), frame...), pair.now)
				side.TakeOutputs()
				_, nxt, rcv, delivered := side.Offsets()
				if delivered > rcv || side.Unacked() > nxt {
					t.Fatalf("offsets broke: delivered %d rcv %d", delivered, rcv)
				}
				for {
					if _, _, ok := side.Read(pair.now); !ok {
						break
					}
				}
			}
		}
	})
}
