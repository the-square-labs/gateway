package stream

import (
	"testing"
	"unicode/utf8"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"google.golang.org/protobuf/proto"
)

// marshalingCommandStream fails a Send exactly like the gRPC codec does when a
// message cannot be marshaled.
type marshalingCommandStream struct {
	pb.NodeControl_CommandStreamClient
	sent []*pb.DaemonMessage
}

func (s *marshalingCommandStream) Send(msg *pb.DaemonMessage) error {
	if _, err := proto.Marshal(msg); err != nil {
		return err
	}
	s.sent = append(s.sent, msg)
	return nil
}

// A Docker multiplexed-stream header: stream type, three zero bytes, and a
// big-endian length whose high byte is not valid UTF-8.
const rawDockerFrame = "\x02\x00\x00\x00\x00\x00\x00\xb2nginx: [emerg] host not found"

func TestWriterSendSanitizesInvalidUTF8CommandResult(t *testing.T) {
	stream := &marshalingCommandStream{}
	writer := NewWriter(stream)
	result := &pb.CommandResult{
		CommandId: "command-1",
		Error:     "reload router failed: " + rawDockerFrame,
		Detail:    "{\"output\":\"\xff\xfe\"}",
		Data:      []byte{0xff, 0xfe},
	}
	if err := writer.Send(&pb.DaemonMessage{Payload: &pb.DaemonMessage_CommandResult{CommandResult: result}}); err != nil {
		t.Fatalf("send must not fail on invalid UTF-8 (a failure ends the daemon session): %v", err)
	}
	if len(stream.sent) != 1 {
		t.Fatalf("sent %d messages, want 1", len(stream.sent))
	}
	sent := stream.sent[0].GetCommandResult()
	for name, value := range map[string]string{"error": sent.Error, "detail": sent.Detail} {
		if !utf8.ValidString(value) {
			t.Fatalf("%s is still invalid UTF-8: %q", name, value)
		}
	}
	if sent.Error != "reload router failed: \x02\x00\x00\x00\x00\x00\x00�nginx: [emerg] host not found" {
		t.Fatalf("error = %q", sent.Error)
	}
	if sent.Detail != "{\"output\":\"�\"}" {
		t.Fatalf("detail = %q", sent.Detail)
	}
	if string(sent.Data) != "\xff\xfe" {
		t.Fatalf("bytes fields must be sent unchanged, got %q", sent.Data)
	}
	if sent.CommandId != "command-1" {
		t.Fatalf("valid fields must be kept, command id = %q", sent.CommandId)
	}
}

func TestWriterSendSanitizesNestedMapsAndLists(t *testing.T) {
	stream := &marshalingCommandStream{}
	writer := NewWriter(stream)
	logEntry := &pb.DaemonLogEntry{
		Message: "deployment failed \xc3",
		Fields: map[string]string{
			"error":    "exec output \xff",
			"bad\xffk": "value",
			"ok":       "fine",
		},
	}
	if err := writer.Send(&pb.DaemonMessage{Payload: &pb.DaemonMessage_DaemonLog{DaemonLog: logEntry}}); err != nil {
		t.Fatalf("send daemon log: %v", err)
	}
	sent := stream.sent[0].GetDaemonLog()
	if sent.Message != "deployment failed �" {
		t.Fatalf("message = %q", sent.Message)
	}
	want := map[string]string{"error": "exec output �", "bad�k": "value", "ok": "fine"}
	if len(sent.Fields) != len(want) {
		t.Fatalf("fields = %q, want %q", sent.Fields, want)
	}
	for key, value := range want {
		if sent.Fields[key] != value {
			t.Fatalf("fields = %q, want %q", sent.Fields, want)
		}
	}

	report := &pb.HealthReport{
		LocalIpAddresses:  []string{"10.0.0.1", "eth\xff"},
		DiskMounts:        []*pb.DiskMount{{MountPoint: "/mnt/\xfe", Device: "sda"}},
		NetworkInterfaces: []*pb.NetworkInterface{{Name: "br-\xff", IpAddresses: []string{"\xff"}}},
	}
	if err := writer.Send(&pb.DaemonMessage{Payload: &pb.DaemonMessage_HealthReport{HealthReport: report}}); err != nil {
		t.Fatalf("send health report: %v", err)
	}
	sentReport := stream.sent[1].GetHealthReport()
	if got := sentReport.LocalIpAddresses; got[0] != "10.0.0.1" || got[1] != "eth�" {
		t.Fatalf("local ip addresses = %q", got)
	}
	if got := sentReport.DiskMounts[0].MountPoint; got != "/mnt/�" {
		t.Fatalf("disk mount point = %q", got)
	}
	if got := sentReport.NetworkInterfaces[0]; got.Name != "br-�" || got.IpAddresses[0] != "�" {
		t.Fatalf("network interface = %v", got)
	}
}

func TestSanitizeUTF8LeavesValidMessagesUntouched(t *testing.T) {
	result := &pb.CommandResult{CommandId: "c", Error: "всё хорошо ✓", Detail: "{}"}
	before := proto.Clone(result)
	SanitizeUTF8(result)
	if !proto.Equal(before, result) {
		t.Fatalf("valid message changed: %v -> %v", before, result)
	}
	SanitizeUTF8(nil)
	SanitizeUTF8((*pb.CommandResult)(nil))
}
