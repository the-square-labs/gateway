package relayresume

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

var updateVectors = flag.Bool("update-vectors", false, "rewrite proto/testdata/relay-resume-v1.json")

const vectorsPath = "../../../../proto/testdata/relay-resume-v1.json"

// vectorWindow is the wnd the record vectors carry (frozen; not tied to the
// current InitialWindow).
const vectorWindow = 256 * 1024

type vectorFile struct {
	Version   int               `json:"version"`
	Spec      string            `json:"spec"`
	Constants map[string]any    `json:"constants"`
	KDF       []kdfVector       `json:"kdf"`
	MACs      []macVector       `json:"macs"`
	Records   []recordVector    `json:"records"`
	Frames    []frameVector     `json:"frames"`
	Invalid   []invalidVector   `json:"invalid"`
	Notes     map[string]string `json:"notes"`
}

type kdfVector struct {
	SecretHex  string `json:"secret_hex"`
	RouteID    string `json:"route_id"`
	KeyVersion string `json:"key_version"`
	InfoHex    string `json:"info_hex"`
	KeyHex     string `json:"key_hex"`
	KeyID      string `json:"key_id"`
}

type macVector struct {
	Name          string `json:"name"`
	Label         string `json:"label"`
	KeyHex        string `json:"key_hex"`
	RouteID       string `json:"route_id"`
	RelayID       string `json:"relay_id"`
	KeyID         string `json:"key_id"`
	SessionIDHex  string `json:"session_id_hex"`
	TargetNonce   string `json:"target_nonce_hex,omitempty"`
	HelloMACHex   string `json:"hello_mac_hex,omitempty"`
	ResumeMACHex  string `json:"resume_mac_hex,omitempty"`
	Wnd           string `json:"wnd,omitempty"`
	Epoch         string `json:"epoch,omitempty"`
	RcvNxt        string `json:"rcv_nxt,omitempty"`
	SendFrom      string `json:"send_from,omitempty"`
	TranscriptHex string `json:"transcript_hex"`
	MACHex        string `json:"mac_hex"`
	RecordHex     string `json:"record_hex"`
}

type recordJSON struct {
	Type         string `json:"type"`
	Ack          string `json:"ack,omitempty"`
	Wnd          string `json:"wnd,omitempty"`
	PayloadHex   string `json:"payload_hex,omitempty"`
	Code         *int   `json:"code,omitempty"`
	ReasonHex    string `json:"reason_hex,omitempty"`
	KeyID        string `json:"key_id,omitempty"`
	SessionIDHex string `json:"session_id_hex,omitempty"`
	NonceHex     string `json:"target_nonce_hex,omitempty"`
	Epoch        string `json:"epoch,omitempty"`
	RcvNxt       string `json:"rcv_nxt,omitempty"`
	SendFrom     string `json:"send_from,omitempty"`
	MACHex       string `json:"mac_hex,omitempty"`
}

type recordVector struct {
	Name   string     `json:"name"`
	Hex    string     `json:"hex"`
	Record recordJSON `json:"record"`
}

type frameVector struct {
	Name    string       `json:"name"`
	Hex     string       `json:"hex"`
	Records []recordJSON `json:"records"`
}

type invalidVector struct {
	Name   string `json:"name"`
	Hex    string `json:"hex"`
	Reason string `json:"reason"`
}

var typeNames = map[byte]string{
	TypeData: "data", TypeAck: "ack", TypeFin: "fin", TypeRst: "rst", TypeClose: "close", TypeHello: "hello",
	TypeHelloAck: "hello_ack", TypeResume: "resume", TypeResumeAck: "resume_ack", TypeResumeRej: "resume_rej",
	TypeMigrateReq: "migrate_req",
}

func u64s(value uint64) string { return strconv.FormatUint(value, 10) }

func toJSON(record *Record) recordJSON {
	out := recordJSON{Type: typeNames[record.Type]}
	code := int(record.Code)
	switch record.Type {
	case TypeData:
		out.Ack, out.PayloadHex = u64s(record.Ack), hex.EncodeToString(record.Payload)
	case TypeAck:
		out.Ack, out.Wnd = u64s(record.Ack), u64s(record.Wnd)
	case TypeFin:
		out.Ack = u64s(record.Ack)
	case TypeRst:
		out.Code, out.ReasonHex = &code, hex.EncodeToString(record.Reason)
	case TypeHello:
		out.KeyID, out.SessionIDHex, out.Wnd, out.MACHex = record.KeyID, hex.EncodeToString(record.SessionID[:]), u64s(record.Wnd), hex.EncodeToString(record.MAC[:])
	case TypeHelloAck:
		out.SessionIDHex, out.NonceHex, out.Wnd, out.MACHex = hex.EncodeToString(record.SessionID[:]), hex.EncodeToString(record.Nonce[:]), u64s(record.Wnd), hex.EncodeToString(record.MAC[:])
	case TypeResume:
		out.SessionIDHex, out.Epoch, out.RcvNxt, out.KeyID, out.MACHex = hex.EncodeToString(record.SessionID[:]), u64s(record.Epoch), u64s(record.RcvNxt), record.KeyID, hex.EncodeToString(record.MAC[:])
	case TypeResumeAck:
		out.SessionIDHex, out.Epoch, out.RcvNxt, out.SendFrom, out.MACHex = hex.EncodeToString(record.SessionID[:]), u64s(record.Epoch), u64s(record.RcvNxt), u64s(record.SendFrom), hex.EncodeToString(record.MAC[:])
	case TypeResumeRej:
		out.SessionIDHex, out.Code = hex.EncodeToString(record.SessionID[:]), &code
	case TypeMigrateReq:
		out.Code = &code
	}
	return out
}

func seqBytes(start byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = start + byte(i)
	}
	return out
}

func buildVectors(t *testing.T) vectorFile {
	t.Helper()
	file := vectorFile{
		Version: 1,
		Spec:    "packages/daemons/shared/relayresume/doc.go (wire format, offsets, MAC transcripts, key derivation)",
		Constants: map[string]any{
			"magic": Magic, "version": Version, "mac_len": MACLen, "session_id_len": SessionIDLen, "nonce_len": NonceLen,
			"key_len": KeyLen, "max_key_id_len": MaxKeyIDLen, "max_frame_bytes": MaxFrameBytes, "transcript_domain": transcriptDomain,
			"capability":     Capability,
			"initial_window": InitialWindow, "fallback_window": FallbackWindow, "min_window": MinWindow, "max_window": MaxWindow, "process_budget": DefaultProcessBudget,
			"delayed_ack_ms": DelayedAck.Milliseconds(), "first_record_timeout_ms": FirstRecordTimeout.Milliseconds(),
			"open_timeout_ms": OpenTimeout.Milliseconds(), "resume_ack_timeout_ms": ResumeAckTimeout.Milliseconds(),
			"hello_ack_timeout_ms": HelloAckTimeout.Milliseconds(), "planned_budget_ms": PlannedBudget.Milliseconds(),
			"unplanned_budget_ms": UnplannedBudget.Milliseconds(), "unplanned_backoff_min_ms": UnplannedBackoffMin.Milliseconds(),
			"unplanned_backoff_max_ms": UnplannedBackoffMax.Milliseconds(), "target_suspend_timeout_ms": TargetSuspendTimeout.Milliseconds(),
			"tombstone_ttl_ms": TombstoneTTL.Milliseconds(), "legacy_latch_ms": LegacyLatch.Milliseconds(),
			"proxy_half_close_timeout_ms": ProxyHalfCloseTimeout.Milliseconds(), "close_linger_timeout_ms": CloseLingerTimeout.Milliseconds(),
			"drain_deadline_margin_ms": DrainDeadlineMargin.Milliseconds(), "max_migrations_in_flight": MaxMigrationsInFlight,
			"record_types": map[string]int{"data": 1, "ack": 2, "fin": 3, "rst": 4, "close": 5, "hello": 16, "hello_ack": 17,
				"resume": 18, "resume_ack": 19, "resume_rej": 20, "migrate_req": 21},
			"reject_codes": map[string]int{"unknown": 1, "finished": 2, "reset": 3, "unauthorized": 4, "stale_epoch": 5},
			"rst_codes": map[string]int{"protocol": 1, "local": 2, "suspend_timeout": 3, "idle": 4, "half_close_idle": 5,
				"revoked": 6, "aborted": 7, "resume_rejected": 8, "legacy_peer": 9, "window_violation": 10},
			"migrate_reasons": map[string]int{"drain": 1, "goaway": 2},
		},
		Notes: map[string]string{
			"integers":  "64-bit values are decimal strings",
			"frames":    "a TunnelData payload is one or more records; DATA is last and runs to the end of the frame",
			"invalid":   "every invalid vector must be rejected by the frame parser",
			"offsets":   "DATA offsets are implicit per path; FIN consumes one offset unit; ack = receiver rcv_nxt (bytes handed to the local socket)",
			"handshake": "the target table key is (route_id, source_kind, source_id, session_id) from the relay-vouched IncomingTunnel.route",
		},
	}

	secret := seqBytes(0x00, 32)
	for _, item := range []struct {
		route   string
		version uint64
	}{{"route-1", 1}, {"7f1c2a9e-5b3d-4c8e-9a10-2b3c4d5e6f70", 42}} {
		key, err := DeriveRouteKey(secret, item.route, item.version)
		if err != nil {
			t.Fatal(err)
		}
		info := appendStr([]byte(transcriptDomain), item.route)
		info = append(info, 0, 0, 0, 0, 0, 0, 0, 0)
		info[len(info)-1] = byte(item.version)
		file.KDF = append(file.KDF, kdfVector{SecretHex: hex.EncodeToString(secret), RouteID: item.route, KeyVersion: u64s(item.version),
			InfoHex: hex.EncodeToString(info), KeyHex: hex.EncodeToString(key), KeyID: RouteKeyID(item.version)})
	}

	key, _ := DeriveRouteKey(secret, "route-1", 1)
	ctx := PathContext{RouteID: "route-1", RelayID: "relay-a", KeyID: "v1", Key: key}
	copy(ctx.SessionID[:], seqBytes(0x10, 16))
	var nonce [NonceLen]byte
	copy(nonce[:], seqBytes(0xa0, 16))

	helloMAC := ComputeMAC(key, ctx.HelloTranscript(vectorWindow))
	hello := Record{Type: TypeHello, KeyID: "v1", SessionID: ctx.SessionID, Wnd: vectorWindow, MAC: helloMAC}
	ctx.HelloMAC = helloMAC
	helloAckMAC := ComputeMAC(key, ctx.HelloAckTranscript(nonce, vectorWindow))
	helloAck := Record{Type: TypeHelloAck, SessionID: ctx.SessionID, Nonce: nonce, Wnd: vectorWindow, MAC: helloAckMAC}

	resumeCtx := ctx
	resumeCtx.RelayID = "relay-b"
	resumeCtx.TargetNonce = nonce
	resumeMAC := ComputeMAC(key, resumeCtx.ResumeTranscript(2, 300000))
	resume := Record{Type: TypeResume, SessionID: ctx.SessionID, Epoch: 2, RcvNxt: 300000, KeyID: "v1", MAC: resumeMAC}
	resumeCtx.ResumeMAC = resumeMAC
	resumeAckMAC := ComputeMAC(key, resumeCtx.ResumeAckTranscript(2, 5000000000, 300000))
	resumeAck := Record{Type: TypeResumeAck, SessionID: ctx.SessionID, Epoch: 2, RcvNxt: 5000000000, SendFrom: 300000, MAC: resumeAckMAC}

	addMAC := func(name, label string, c PathContext, transcript []byte, mac [MACLen]byte, record *Record, fields macVector) {
		encoded, err := AppendRecord(nil, record)
		if err != nil {
			t.Fatal(err)
		}
		fields.Name, fields.Label, fields.KeyHex, fields.RouteID, fields.RelayID, fields.KeyID = name, label, hex.EncodeToString(c.Key), c.RouteID, c.RelayID, c.KeyID
		fields.SessionIDHex, fields.TranscriptHex, fields.MACHex, fields.RecordHex = hex.EncodeToString(c.SessionID[:]), hex.EncodeToString(transcript), hex.EncodeToString(mac[:]), hex.EncodeToString(encoded)
		file.MACs = append(file.MACs, fields)
	}
	addMAC("hello", "hello", ctx, ctx.HelloTranscript(vectorWindow), helloMAC, &hello, macVector{Wnd: u64s(vectorWindow)})
	addMAC("hello_ack", "hello_ack", ctx, ctx.HelloAckTranscript(nonce, vectorWindow), helloAckMAC, &helloAck,
		macVector{Wnd: u64s(vectorWindow), TargetNonce: hex.EncodeToString(nonce[:]), HelloMACHex: hex.EncodeToString(helloMAC[:])})
	addMAC("resume", "resume", resumeCtx, resumeCtx.ResumeTranscript(2, 300000), resumeMAC, &resume,
		macVector{Epoch: "2", RcvNxt: "300000", TargetNonce: hex.EncodeToString(nonce[:])})
	addMAC("resume_ack", "resume_ack", resumeCtx, resumeCtx.ResumeAckTranscript(2, 5000000000, 300000), resumeAckMAC, &resumeAck,
		macVector{Epoch: "2", RcvNxt: "5000000000", SendFrom: "300000", TargetNonce: hex.EncodeToString(nonce[:]), ResumeMACHex: hex.EncodeToString(resumeMAC[:])})

	records := []struct {
		name   string
		record Record
	}{
		{"data_small", Record{Type: TypeData, Ack: 0, Payload: []byte("hello, world")}},
		{"data_ack_300", Record{Type: TypeData, Ack: 300, Payload: []byte{0x00}}},
		{"data_ack_max", Record{Type: TypeData, Ack: ^uint64(0), Payload: []byte{0xff, 0x00}}},
		{"ack", Record{Type: TypeAck, Ack: 65536, Wnd: vectorWindow}},
		{"ack_zero", Record{Type: TypeAck, Ack: 0, Wnd: MinWindow}},
		{"fin", Record{Type: TypeFin, Ack: 127}},
		{"fin_128", Record{Type: TypeFin, Ack: 128}},
		{"rst", Record{Type: TypeRst, Code: RstLocal, Reason: []byte("connection reset by peer")}},
		{"rst_empty", Record{Type: TypeRst, Code: RstSuspendTimeout}},
		{"close", Record{Type: TypeClose}},
		{"hello", hello},
		{"hello_ack", helloAck},
		{"resume", resume},
		{"resume_ack", resumeAck},
		{"resume_rej_unknown", Record{Type: TypeResumeRej, SessionID: ctx.SessionID, Code: RejectUnknown}},
		{"resume_rej_stale", Record{Type: TypeResumeRej, SessionID: ctx.SessionID, Code: RejectStaleEpoch}},
		{"migrate_req", Record{Type: TypeMigrateReq, Code: MigrateDrain}},
	}
	for _, item := range records {
		encoded, err := AppendRecord(nil, &item.record)
		if err != nil {
			t.Fatalf("%s: %v", item.name, err)
		}
		file.Records = append(file.Records, recordVector{Name: item.name, Hex: hex.EncodeToString(encoded), Record: toJSON(&item.record)})
	}

	frames := []struct {
		name    string
		records []Record
	}{
		{"hello_then_data", []Record{hello, {Type: TypeData, Ack: 0, Payload: []byte("GET / HTTP/1.1\r\n")}}},
		{"hello_ack_ack_data", []Record{helloAck, {Type: TypeAck, Ack: 16, Wnd: vectorWindow}, {Type: TypeData, Ack: 16, Payload: []byte("HTTP/1.1 200 OK\r\n")}}},
		{"ack_fin", []Record{{Type: TypeAck, Ack: 1000, Wnd: vectorWindow}, {Type: TypeFin, Ack: 1000}}},
		{"fin_close", []Record{{Type: TypeFin, Ack: 7}, {Type: TypeClose}}},
		{"migrate_req_ack", []Record{{Type: TypeMigrateReq, Code: MigrateGoAway}, {Type: TypeAck, Ack: 1, Wnd: MaxWindow}}},
	}
	for _, item := range frames {
		var encoded []byte
		var out []recordJSON
		for i := range item.records {
			var err error
			if encoded, err = AppendRecord(encoded, &item.records[i]); err != nil {
				t.Fatal(err)
			}
			out = append(out, toJSON(&item.records[i]))
		}
		file.Frames = append(file.Frames, frameVector{Name: item.name, Hex: hex.EncodeToString(encoded), Records: out})
	}

	helloHex, _ := AppendRecord(nil, &hello)
	invalid := []struct{ name, hexValue, reason string }{
		{"empty", "", "empty frame"},
		{"unknown_type", "06", "unknown record type"},
		{"unknown_type_high", "ff00", "unknown record type"},
		{"data_empty_payload", "0100", "empty DATA payload"},
		{"data_no_ack", "01", "truncated uvarint"},
		{"ack_truncated", "0205", "missing wnd"},
		{"uvarint_overlong", "02800000", "non-minimal uvarint"},
		{"uvarint_overflow", "03ffffffffffffffffff02", "uvarint over 64 bits"},
		{"uvarint_11_bytes", "03ffffffffffffffffff8001", "uvarint over 10 bytes"},
		{"fin_trailing_garbage", "030506", "unknown record type after FIN"},
		{"rst_short_reason", "040205616263", "reason shorter than its length"},
		{"rst_truncated", "04", "truncated RST"},
		{"hello_bad_magic", "10" + hex.EncodeToString([]byte("GWRX")) + hex.EncodeToString(helloHex[5:]), "bad magic"},
		{"hello_bad_version", "10" + hex.EncodeToString([]byte(Magic)) + "02" + hex.EncodeToString(helloHex[6:]), "unknown version"},
		{"hello_zero_key_id", "10" + hex.EncodeToString([]byte(Magic)) + "0100" + hex.EncodeToString(seqBytes(0x10, 16)) + "0100" + hex.EncodeToString(make([]byte, 16)), "empty key id"},
		{"hello_truncated_mac", hex.EncodeToString(helloHex[:len(helloHex)-1]), "truncated MAC"},
		{"resume_rej_truncated", "14" + hex.EncodeToString(seqBytes(0x10, 16)), "missing code"},
		{"migrate_req_truncated", "15", "missing reason"},
	}
	for _, item := range invalid {
		file.Invalid = append(file.Invalid, invalidVector{Name: item.name, Hex: item.hexValue, Reason: item.reason})
	}
	return file
}

func TestVectorsFile(t *testing.T) {
	file := buildVectors(t)
	encoded, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	encoded = append(encoded, '\n')
	if *updateVectors {
		if err := os.MkdirAll(filepath.Dir(vectorsPath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(vectorsPath, encoded, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	stored, err := os.ReadFile(vectorsPath)
	if err != nil {
		t.Fatalf("read vectors (run with -update-vectors to create): %v", err)
	}
	if !bytes.Equal(stored, encoded) {
		t.Fatal("proto/testdata/relay-resume-v1.json does not match the codec; the format is frozen")
	}
}

// TestVectorsDecode checks the stored file independently of the generator.
func TestVectorsDecode(t *testing.T) {
	stored, err := os.ReadFile(vectorsPath)
	if err != nil {
		t.Skip("no vectors file")
	}
	var file vectorFile
	if err := json.Unmarshal(stored, &file); err != nil {
		t.Fatal(err)
	}
	for _, vector := range file.KDF {
		secret, _ := hex.DecodeString(vector.SecretHex)
		version, _ := strconv.ParseUint(vector.KeyVersion, 10, 64)
		key, err := DeriveRouteKey(secret, vector.RouteID, version)
		if err != nil || hex.EncodeToString(key) != vector.KeyHex || RouteKeyID(version) != vector.KeyID {
			t.Fatalf("kdf %s", vector.RouteID)
		}
	}
	for _, vector := range file.MACs {
		key, _ := hex.DecodeString(vector.KeyHex)
		transcript, _ := hex.DecodeString(vector.TranscriptHex)
		mac := ComputeMAC(key, transcript)
		if hex.EncodeToString(mac[:]) != vector.MACHex {
			t.Fatalf("mac %s", vector.Name)
		}
		raw, _ := hex.DecodeString(vector.RecordHex)
		record, rest, err := ParseRecord(raw)
		if err != nil || len(rest) != 0 || !bytes.Equal(record.MAC[:], mac[:]) {
			t.Fatalf("mac record %s: %v", vector.Name, err)
		}
	}
	for _, vector := range file.Records {
		raw, _ := hex.DecodeString(vector.Hex)
		record, rest, err := ParseRecord(raw)
		if err != nil || len(rest) != 0 {
			t.Fatalf("record %s: %v", vector.Name, err)
		}
		if got := toJSON(&record); got.Type != vector.Record.Type || got.Ack != vector.Record.Ack || got.PayloadHex != vector.Record.PayloadHex || got.MACHex != vector.Record.MACHex {
			t.Fatalf("record %s decodes to %+v", vector.Name, got)
		}
		again, err := AppendRecord(nil, &record)
		if err != nil || !bytes.Equal(again, raw) {
			t.Fatalf("record %s does not round-trip", vector.Name)
		}
	}
	for _, vector := range file.Frames {
		raw, _ := hex.DecodeString(vector.Hex)
		records, err := ParseFrame(raw)
		if err != nil || len(records) != len(vector.Records) {
			t.Fatalf("frame %s: %v", vector.Name, err)
		}
	}
	for _, vector := range file.Invalid {
		raw, _ := hex.DecodeString(vector.Hex)
		if _, err := ParseFrame(raw); err == nil {
			t.Fatalf("invalid vector %s parsed", vector.Name)
		}
	}
}
